import {
  chmod,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  BundledSkillLeaveReason,
  BundledSkillOpKind
} from '../../../shared/bundled-skill-plan'
import {
  summarizeBundledSkillOutcomes,
  summarizeBundledSkillPlan
} from '../../../shared/bundled-skill-summary'
import type { SkillInstallProviderId } from '../../../shared/skill-install-providers'
import {
  moveAcrossFilesystems,
  nativeBundledSkillFilesystem,
  type BundledSkillFilesystem
} from './filesystem'
import { skillInstallReceiptPath } from '../skill-install-provenance'
import { skillInstallJournalPath } from '../skill-install-recovery'
import { installBundledSkills, previewBundledSkillInstall } from './service'
import {
  linkDirectory,
  makeSkillHome,
  NAME,
  NEW_TEXT,
  NPX_LOCK,
  OLD_TEXT,
  opsOf,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  snapshot,
  writeCopy,
  writeNpxLock,
  leftoverSiblings,
  type SkillHome
} from './skill-home.test-support'

type Label = 'shared' | 'claude' | 'cursor'

type Layout = {
  name: string
  arrange: (home: SkillHome) => Promise<void>
  ops: [Label, BundledSkillOpKind, BundledSkillLeaveReason?][]
  /** CLI warning leaves do not imply failure. */
  text: string
  badge?: 'update' | null
  agents?: SkillInstallProviderId[]
  force?: Label[]
  installedOnly?: boolean
  filesystem?: BundledSkillFilesystem
  /** Paths outside every target that the run must leave byte-identical. */
  untouched?: (home: SkillHome) => string[]
  posixOnly?: boolean
}

const EDITED_TEXT = `---\nname: ${NAME}\n---\nmine\n`

const noLinks: BundledSkillFilesystem = { ...nativeBundledSkillFilesystem, supportsLinks: false }

async function linkClaudeToShared(home: SkillHome) {
  await mkdir(dirname(home.claude), { recursive: true })
  await linkDirectory(home.shared, home.claude)
}

async function npxShared(home: SkillHome, text = OLD_TEXT, extra: Record<string, string> = {}) {
  await writeNpxLock(home)
  await writeCopy(home.shared, text, extra)
  await linkClaudeToShared(home)
}

const LAYOUTS: Layout[] = [
  {
    name: 'npx shared copy linked into Claude',
    arrange: (home) => npxShared(home),
    ops: [
      ['shared', 'update'],
      ['claude', 'keep']
    ],
    text: 'Updated',
    badge: 'update'
  },
  {
    name: 'npx single-agent real folder in ~/.claude/skills, no shared copy',
    arrange: async (home) => {
      await writeNpxLock(home)
      await writeCopy(home.claude, OLD_TEXT)
    },
    ops: [
      ['shared', 'write'],
      ['claude', 'update']
    ],
    text: 'Updated',
    badge: 'update'
  },
  {
    name: 'update: npx Claude-only install, four other agents detected, spreads to none',
    arrange: async (home) => {
      await writeNpxLock(home)
      await writeCopy(home.claude, OLD_TEXT)
    },
    agents: ['claude', 'codex', 'cursor', 'gemini', 'grok'],
    installedOnly: true,
    ops: [['claude', 'update']],
    text: 'Updated',
    badge: 'update',
    untouched: (home) => [
      home.shared,
      home.cursor,
      join(home.home, '.gemini', 'skills'),
      join(home.home, '.grok', 'skills')
    ]
  },
  {
    name: 'already current',
    arrange: async (home) => {
      await writeCopy(home.shared, NEW_TEXT)
      await linkClaudeToShared(home)
    },
    ops: [
      ['shared', 'keep'],
      ['claude', 'keep']
    ],
    text: 'No change',
    badge: null
  },
  {
    name: 'shared copy edited by the user',
    arrange: (home) => npxShared(home, EDITED_TEXT),
    ops: [
      ['shared', 'leave', 'edited'],
      ['claude', 'leave', 'shared-not-current']
    ],
    text: "No change · 1 skipped: Skill edited outside Orca; The shared copy isn't Orca's",
    badge: null
  },
  {
    name: 'agent folder is a link out of Orca’s folders',
    arrange: async (home) => {
      await npxShared(home)
      await writeCopy(join(home.root, 'elsewhere', NAME), OLD_TEXT)
      await mkdir(dirname(home.cursor), { recursive: true })
      await linkDirectory(join(home.root, 'elsewhere', NAME), home.cursor)
    },
    agents: ['claude', 'cursor'],
    ops: [
      ['shared', 'update'],
      ['claude', 'keep'],
      ['cursor', 'leave', 'other']
    ],
    text: 'Updated · 1 skipped: A different skill uses this name',
    untouched: (home) => [join(home.root, 'elsewhere', NAME)]
  },
  {
    name: 'agent folder is a broken link Orca did not make',
    arrange: async (home) => {
      await writeNpxLock(home)
      await writeCopy(home.shared, OLD_TEXT)
      await mkdir(dirname(home.claude), { recursive: true })
      await linkDirectory(join(home.root, 'gone', NAME), home.claude)
    },
    ops: [
      ['shared', 'update'],
      ['claude', 'leave', 'other']
    ],
    text: 'Updated · 1 skipped: A different skill uses this name'
  },
  {
    name: 'plugin-managed copy only',
    arrange: (home) =>
      writeCopy(join(home.home, '.claude', 'plugins', 'cache', 'v', NAME), OLD_TEXT),
    ops: [
      ['shared', 'write'],
      ['claude', 'link']
    ],
    text: 'Installed',
    badge: null,
    untouched: (home) => [join(home.home, '.claude', 'plugins', 'cache', 'v', NAME)]
  },
  {
    name: 'shared folder is read-only',
    posixOnly: true,
    arrange: async (home) => {
      await npxShared(home)
      await chmod(dirname(home.shared), 0o555)
    },
    ops: [
      ['shared', 'leave', 'unwritable'],
      ['claude', 'leave', 'shared-not-current']
    ],
    text: "No change · 1 skipped: Orca can't write to this folder; The shared copy isn't Orca's"
  },
  {
    name: 'npx shared copy with Claude and Cursor detected',
    agents: ['claude', 'cursor'],
    arrange: (home) => npxShared(home),
    ops: [
      ['shared', 'update'],
      ['claude', 'keep'],
      ['cursor', 'link']
    ],
    text: 'Updated'
  },
  {
    name: 'current install with a newly detected agent (link only, not an update)',
    agents: ['claude', 'cursor'],
    arrange: async (home) => {
      await writeCopy(home.shared, NEW_TEXT)
      await linkClaudeToShared(home)
    },
    ops: [
      ['shared', 'keep'],
      ['claude', 'keep'],
      ['cursor', 'link']
    ],
    text: 'Linked',
    badge: null
  },
  {
    name: 'the user’s own same-named skill',
    arrange: (home) => writeCopy(home.shared, '---\nname: something-else\n---\n'),
    ops: [
      ['shared', 'leave', 'other'],
      ['claude', 'leave', 'shared-not-current']
    ],
    text: "No change · 1 skipped: A different skill uses this name; The shared copy isn't Orca's"
  },
  {
    name: 'host that cannot link gets a copy',
    filesystem: noLinks,
    arrange: async () => undefined,
    ops: [
      ['shared', 'write'],
      ['claude', 'copy']
    ],
    text: 'Installed'
  },
  {
    name: 'released copy with CRLF line endings',
    arrange: (home) => npxShared(home, OLD_TEXT.replace(/\n/gu, '\r\n')),
    ops: [
      ['shared', 'update'],
      ['claude', 'keep']
    ],
    text: 'Updated'
  },
  {
    name: 'released copy with a .DS_Store',
    arrange: (home) => npxShared(home, OLD_TEXT, { '.DS_Store': '\u0000\u0001' }),
    ops: [
      ['shared', 'update'],
      ['claude', 'keep']
    ],
    text: 'Updated'
  },
  {
    name: 'released copy plus a file the user added',
    arrange: (home) => npxShared(home, OLD_TEXT, { 'notes.md': 'mine\n' }),
    ops: [
      ['shared', 'leave', 'edited'],
      ['claude', 'leave', 'shared-not-current']
    ],
    text: "No change · 1 skipped: Skill edited outside Orca; The shared copy isn't Orca's"
  },
  {
    name: '~/.claude/skills is a link to ~/.agents/skills (one target)',
    arrange: async (home) => {
      await writeCopy(home.shared, OLD_TEXT)
      await mkdir(join(home.home, '.claude'), { recursive: true })
      await linkDirectory(dirname(home.shared), dirname(home.claude))
    },
    ops: [['shared', 'update']],
    text: 'Updated'
  },
  {
    name: 'Replace an edited shared copy keeps a backup',
    arrange: (home) => npxShared(home, EDITED_TEXT),
    force: ['shared'],
    ops: [
      ['shared', 'replace'],
      ['claude', 'keep']
    ],
    text: 'Updated'
  },
  {
    name: 'Replace an outside link moves the link, not its target',
    agents: ['claude', 'cursor'],
    arrange: async (home) => {
      await npxShared(home)
      await writeCopy(join(home.root, 'dotfiles', NAME), 'theirs\n')
      await mkdir(dirname(home.cursor), { recursive: true })
      await linkDirectory(join(home.root, 'dotfiles', NAME), home.cursor)
    },
    force: ['cursor'],
    ops: [
      ['shared', 'update'],
      ['claude', 'keep'],
      ['cursor', 'replace']
    ],
    text: 'Updated',
    untouched: (home) => [join(home.root, 'dotfiles', NAME)]
  }
]

afterEach(async () => {
  await removeSkillHomes()
})

describe('bundled skill install across real layouts', () => {
  const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0
  it.each(LAYOUTS.map((layout) => [layout.name, layout] as const))('%s', async (_name, layout) => {
    if (layout.posixOnly && !canChmod) {
      return
    }
    const home = await makeSkillHome()
    await layout.arrange(home)
    const input = serviceInput(home, {
      agents: layout.agents ?? ['claude'],
      ...(layout.force ? { force: layout.force.map((label) => home[label]) } : {}),
      ...(layout.installedOnly ? { installedOnly: true } : {}),
      ...(layout.filesystem ? { filesystem: layout.filesystem } : {})
    })
    const untouched = layout.untouched?.(home) ?? []
    const lockBefore = await readFile(home.lock, 'utf8').catch(() => null)
    const untouchedBefore = await Promise.all(untouched.map(snapshot))

    const preview = await previewBundledSkillInstall(input)
    expect(opsOf(preview)).toEqual(
      layout.ops.map(([label, kind, reason]) => [home[label], kind, reason])
    )
    if (layout.badge !== undefined) {
      expect(summarizeBundledSkillPlan(preview).badge).toBe(layout.badge)
    }
    const leftBefore = await Promise.all(
      preview.skills[0].ops.filter((op) => op.kind === 'leave').map((op) => snapshot(op.path))
    )

    const { plan, result } = await previewAndInstall(input)
    expect(plan.planDigest).toBe(preview.planDigest)
    const summary = summarizeBundledSkillOutcomes(result)
    expect(summary.skills.map((skill) => skill.line)).toEqual([layout.text])
    // Refused folders warn; only failed or changed operations fail the CLI.
    expect(summary.exitCode).toBe(0)

    for (const op of plan.skills[0].ops) {
      if (op.kind === 'link' || op.content === 'link') {
        expect(await realpath(op.path)).toBe(await realpath(home.shared))
        expect((await snapshot(op.path)).startsWith('link:')).toBe(true)
      } else if (op.content === 'files') {
        expect(await snapshot(op.path)).toBe(`dir[SKILL.md]:${NEW_TEXT}`)
      }
      expect(await leftoverSiblings(op.path)).toEqual([])
    }
    expect(
      await Promise.all(
        plan.skills[0].ops.filter((op) => op.kind === 'leave').map((op) => snapshot(op.path))
      )
    ).toEqual(leftBefore)
    expect(await Promise.all(untouched.map(snapshot))).toEqual(untouchedBefore)
    expect(await readFile(home.lock, 'utf8').catch(() => null)).toBe(lockBefore)
    if (lockBefore !== null) {
      expect(lockBefore).toBe(NPX_LOCK)
    }

    const again = await previewBundledSkillInstall({ ...input, force: [] })
    expect(again.skills[0].ops.every((op) => op.kind === 'keep' || op.kind === 'leave')).toBe(true)
  })
})

describe('bundled skill install edges', () => {
  it('keeps the replaced copy in a backup beside the skills root', async () => {
    const home = await makeSkillHome()
    await npxShared(home, EDITED_TEXT)
    const { result } = await previewAndInstall(serviceInput(home, { force: [home.shared] }))
    const backup = result.skills[0].ops[0].backupPath ?? ''
    expect(backup.startsWith(join(home.home, '.agents', '.orca-skill-backups', `${NAME}-`))).toBe(
      true
    )
    expect(await readFile(join(backup, 'SKILL.md'), 'utf8')).toBe(EDITED_TEXT)
  })

  it('keeps a project Replace backup in the home, not the repo', async () => {
    const home = await makeSkillHome()
    const project = join(home.root, 'project')
    const projectShared = join(project, '.agents', 'skills', NAME)
    await writeCopy(projectShared, EDITED_TEXT)
    const input = serviceInput(home, { workspaceDirectory: project, force: [projectShared] })
    const { result } = await previewAndInstall(input)
    const backup = result.skills[0].ops[0].backupPath ?? ''
    expect(backup.startsWith(join(home.home, '.agents', '.orca-skill-backups', `${NAME}-`))).toBe(
      true
    )
    expect(await readFile(join(backup, 'SKILL.md'), 'utf8')).toBe(EDITED_TEXT)
    expect(await snapshot(join(project, '.agents', '.orca-skill-backups'))).toBe('missing')
  })

  // This test needs file symlinks (Developer Mode on Windows); product installs use directory links.
  it.skipIf(process.platform === 'win32')(
    'moves a backup across filesystems by copying, verifying, then removing',
    async () => {
      const home = await makeSkillHome()
      const source = join(home.root, 'source', NAME)
      await writeCopy(source, EDITED_TEXT, { 'notes.md': 'mine\n' })
      await symlink('notes.md', join(source, 'link.md'))
      const target = join(home.root, 'backups', NAME)
      await mkdir(dirname(target), { recursive: true })
      const crossDevice = async () => {
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      }
      await moveAcrossFilesystems(source, target, crossDevice)
      expect(await snapshot(source)).toBe('missing')
      expect(await snapshot(target)).toBe(`dir[SKILL.md,link.md,notes.md]:${EDITED_TEXT}`)
      expect(await readlink(join(target, 'link.md'))).toBe('notes.md')
    }
  )

  it('links into a project only where its agent folder already exists', async () => {
    const home = await makeSkillHome()
    const project = join(home.root, 'project')
    await writeCopy(join(project, '.claude', 'skills', NAME), OLD_TEXT)
    const input = serviceInput(home, { agents: ['claude', 'droid'], workspaceDirectory: project })
    const { plan } = await previewAndInstall(input)
    expect(opsOf(plan)).toEqual([
      [join(project, '.agents', 'skills', NAME), 'write', undefined],
      [join(project, '.claude', 'skills', NAME), 'update', undefined]
    ])
    expect(summarizeBundledSkillPlan(plan).badge).toBeNull()
    expect(await snapshot(home.shared)).toBe('missing')
  })

  it('updates a Claude profile folder through its link to ~/.claude/skills', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.claude, OLD_TEXT)
    const profileSkills = join(home.root, 'profile', 'skills')
    await mkdir(dirname(profileSkills), { recursive: true })
    await linkDirectory(dirname(home.claude), profileSkills)
    const viaProfile = serviceInput(home, { providerRootOverrides: { claude: profileSkills } })
    const viaHome = serviceInput(home)
    const previewViaHome = await previewBundledSkillInstall(viaHome)

    const { plan } = await previewAndInstall(viaProfile)
    expect(opsOf(plan)[1]).toEqual([join(profileSkills, NAME), 'update', undefined])
    expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    expect(await readlink(profileSkills)).toBe(dirname(home.claude))

    const stale = await installBundledSkills(viaHome, previewViaHome.planDigest)
    expect(stale.skills).toEqual([{ name: NAME, status: 'changed', ops: [] }])
  })

  it('reads a pending cloud transaction as busy and a cloud receipt as another skill', async () => {
    const home = await makeSkillHome()
    await npxShared(home)
    const journal = skillInstallJournalPath(home.state, home.shared)
    await mkdir(dirname(journal), { recursive: true })
    await writeFile(journal, '{}')
    expect(opsOf(await previewBundledSkillInstall(serviceInput(home)))).toEqual([
      [home.shared, 'leave', 'busy'],
      [home.claude, 'leave', 'shared-not-current']
    ])

    const receipt = skillInstallReceiptPath(home.state, home.shared)
    await mkdir(dirname(receipt), { recursive: true })
    await writeFile(receipt, '{}')
    await rm(journal)
    expect(opsOf(await previewBundledSkillInstall(serviceInput(home)))[0]).toEqual([
      home.shared,
      'leave',
      'other'
    ])
    await previewAndInstall(serviceInput(home, { force: [home.shared] }))
    expect(opsOf(await previewBundledSkillInstall(serviceInput(home)))[0]).toEqual([
      home.shared,
      'keep',
      undefined
    ])
  })
})
