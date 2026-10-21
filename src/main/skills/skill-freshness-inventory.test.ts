import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { SkillBundleFileIdentity, SkillCurrentBundleEntry } from '../../shared/skill-freshness'
import {
  inventorySkillFreshness,
  MAXIMUM_REPOSITORY_SKILL_ROOTS
} from './skill-freshness-inventory'
import { describeObservedSkillFile, skillPackageDigest } from './skill-package-identity'
import { MAXIMUM_PLUGIN_SCAN_ENTRIES } from './skill-plugin-cache-scan'
import { getSkillFreshnessDisplayStatus } from '../../renderer/src/lib/skill-freshness-display-status'

const temporaryDirectories: string[] = []

function bundleEntry(markdown: string): SkillCurrentBundleEntry {
  const observed = describeObservedSkillFile('SKILL.md', Buffer.from(markdown), false)
  const file: SkillBundleFileIdentity = {
    path: observed.path,
    size: observed.size,
    executable: observed.executable,
    classification: observed.classification,
    exactSha256: observed.exactSha256,
    textNormalizedSha256: observed.textNormalizedSha256,
    identitySha256: observed.identitySha256
  }
  return {
    name: 'orca-cli',
    sourcePath: 'skills/orca-cli',
    packageDigest: skillPackageDigest([file]),
    files: [file]
  }
}

async function writeSkillLock(
  homeDir: string,
  entry: { source?: string; skillFolderHash?: string } | null
): Promise<void> {
  await mkdir(join(homeDir, '.agents'), { recursive: true })
  await writeFile(
    join(homeDir, '.agents', '.skill-lock.json'),
    `${JSON.stringify({
      version: 3,
      skills: entry ? { 'orca-cli': { skillPath: 'skills/orca-cli/SKILL.md', ...entry } } : {}
    })}\n`
  )
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-inventory-'))
  temporaryDirectories.push(root)
  const homeDir = join(root, 'home')
  const resourceRoot = join(root, 'resources')
  await mkdir(join(resourceRoot, 'skills'), { recursive: true })

  const oldMarkdown = '---\nname: orca-cli\ndescription: Old official guide.\n---\n\n# Old\n'
  const currentMarkdown =
    '---\nname: orca-cli\ndescription: Current official guide.\n---\n\n# Current\n'
  // Why: what an install between releases left; no list of shipped versions knows it.
  const unreleasedMarkdown =
    '---\nname: orca-cli\ndescription: Main between releases.\n---\n\n# Unreleased\n'
  await Promise.all([
    writeSkillLock(homeDir, { source: 'stablyai/orca', skillFolderHash: 'b'.repeat(40) }),
    writeFile(
      join(resourceRoot, 'skills', 'current-manifest.json'),
      `${JSON.stringify({ schemaVersion: 3, skills: [bundleEntry(currentMarkdown)] }, null, 2)}\n`
    )
  ])

  const writeSkill = async (rootPath: string, markdown: string): Promise<string> => {
    const directory = join(rootPath, 'orca-cli')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), markdown)
    return directory
  }
  const scan = (overrides: { repos?: Repo[] } = {}) =>
    inventorySkillFreshness({
      homeDir,
      repos: overrides.repos ?? [],
      resourceRoot,
      stateHome: null
    })
  return {
    root,
    homeDir,
    resourceRoot,
    oldMarkdown,
    currentMarkdown,
    unreleasedMarkdown,
    writeSkill,
    scan
  }
}

beforeEach(() => {
  // Why: provider roots follow these variables; the host's real values would point the
  // scan at the developer's own skill folders.
  for (const name of ['CLAUDE_CONFIG_DIR', 'GROK_HOME', 'HERMES_HOME', 'XDG_STATE_HOME']) {
    vi.stubEnv(name, '')
  }
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
})

const linkType = process.platform === 'win32' ? 'junction' : 'dir'

describe('read-only skill freshness inventory', () => {
  it('reads an older official copy as outdated and offers it', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)

    const inventory = await test.scan()

    expect(inventory.installations.map((entry) => entry.status)).toEqual(['outdated'])
    expect(inventory.installations[0]?.lockSource).toBe('stablyai/orca')
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
    expect(getSkillFreshnessDisplayStatus(inventory, 'orca-cli')).toBe('update-available')
  })

  it('reads the shipped bytes as current, with CRLF or without', async () => {
    for (const markdown of [
      (await fixture()).currentMarkdown,
      (await fixture()).currentMarkdown.replaceAll('\n', '\r\n')
    ]) {
      const test = await fixture()
      await test.writeSkill(join(test.homeDir, '.agents', 'skills'), markdown)

      const inventory = await test.scan()

      expect(inventory.installations.map((entry) => entry.status)).toEqual(['current'])
      expect(inventory.eligibleUpdateNames).toEqual([])
      expect(getSkillFreshnessDisplayStatus(inventory, 'orca-cli')).toBe('up-to-date')
    }
  })

  // #26841: each of these stranded an untouched Orca-installed copy as "modified".
  describe('an Orca-owned copy of another version reads outdated and eligible (#26841)', () => {
    it('with bytes from a version no release list knows', async () => {
      const test = await fixture()
      await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.unreleasedMarkdown)

      const inventory = await test.scan()

      expect(inventory.installations[0]).toMatchObject({
        topology: 'canonical-copy',
        status: 'outdated'
      })
      expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
      expect(getSkillFreshnessDisplayStatus(inventory, 'orca-cli')).toBe('update-available')
    })

    it('when the skills CLI recorded a sha256 lock hash', async () => {
      const test = await fixture()
      await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.unreleasedMarkdown)
      await writeSkillLock(test.homeDir, {
        source: 'stablyai/orca',
        skillFolderHash: '7ad2f1fd'.repeat(8)
      })

      const inventory = await test.scan()

      expect(inventory.installations[0]?.status).toBe('outdated')
      expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
    })

    it('with CRLF line endings', async () => {
      const test = await fixture()
      await test.writeSkill(
        join(test.homeDir, '.agents', 'skills'),
        test.unreleasedMarkdown.replaceAll('\n', '\r\n')
      )

      const inventory = await test.scan()

      expect(inventory.installations[0]?.status).toBe('outdated')
      expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
    })

    it('behind a .cac skills junction to .agents skills', async () => {
      const test = await fixture()
      const canonicalRoot = join(test.homeDir, '.agents', 'skills')
      await test.writeSkill(canonicalRoot, test.unreleasedMarkdown)
      const claudeConfig = join(test.homeDir, '.cac')
      await mkdir(claudeConfig, { recursive: true })
      await symlink(canonicalRoot, join(claudeConfig, 'skills'), linkType)
      vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfig)

      const inventory = await test.scan()

      expect(inventory.installations).toHaveLength(1)
      expect(inventory.installations[0]).toMatchObject({
        topology: 'canonical-copy',
        status: 'outdated',
        providers: ['agent-skills', 'claude']
      })
      expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
    })
  })

  it.each([
    ['another source', { source: 'acme/agent-skills' }, 'acme/agent-skills'],
    ['no source', {}, null],
    ['no lock entry', null, null]
  ])(
    'offers a same-named copy from %s without attributing it to Orca',
    async (_label, entry, lockSource) => {
      const test = await fixture()
      await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
      await writeSkillLock(test.homeDir, entry)

      const inventory = await test.scan()

      // Why: eligibility is about safety; preselection reads the ownership each row carries.
      expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
      expect(inventory.installations[0]?.lockSource).toBe(lockSource)
      expect(getSkillFreshnessDisplayStatus(inventory, 'orca-cli')).toBe('installed')
    }
  )

  it('keeps a link to a folder outside the skill homes skipped', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const dotfiles = await test.writeSkill(join(test.root, 'dotfiles'), test.oldMarkdown)
    const claudeRoot = join(test.homeDir, '.claude', 'skills')
    await mkdir(claudeRoot, { recursive: true })
    await symlink(dotfiles, join(claudeRoot, 'orca-cli'), linkType)

    const inventory = await test.scan()

    expect(inventory.installations).toEqual(
      expect.arrayContaining([expect.objectContaining({ topology: 'external-link' })])
    )
    // Why: `skills add` rm-then-copies through the link and deletes the dotfiles copy (#22897).
    expect(inventory.eligibleUpdateNames).toEqual([])
    expect(getSkillFreshnessDisplayStatus(inventory, 'orca-cli')).toBe('needs-attention')
  })

  it('reads current beside OS and agent CLI sidecars the bundle does not list', async () => {
    const test = await fixture()
    const directory = await test.writeSkill(
      join(test.homeDir, '.agents', 'skills'),
      test.currentMarkdown
    )
    await writeFile(join(directory, '.DS_Store'), Buffer.from([0, 1, 2, 3]))
    await mkdir(join(directory, 'agents'), { recursive: true })
    await writeFile(join(directory, 'agents', 'openai.yaml'), 'display_name: test\n')

    const inventory = await test.scan()

    expect(inventory.installations.map((entry) => entry.status)).toEqual(['current'])
    expect(inventory.eligibleUpdateNames).toEqual([])
  })

  it('reads a local edit as outdated, not as a separate verdict', async () => {
    const test = await fixture()
    await test.writeSkill(
      join(test.homeDir, '.agents', 'skills'),
      `${test.currentMarkdown}\nLocal edit.\n`
    )

    const inventory = await test.scan()

    expect(inventory.installations[0]?.status).toBe('outdated')
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it('deduplicates a provider alias to the canonical copy', async () => {
    const test = await fixture()
    const canonical = await test.writeSkill(
      join(test.homeDir, '.agents', 'skills'),
      test.oldMarkdown
    )
    const claudeRoot = join(test.homeDir, '.claude', 'skills')
    await mkdir(claudeRoot, { recursive: true })
    await symlink(canonical, join(claudeRoot, 'orca-cli'), linkType)

    const inventory = await test.scan()

    expect(inventory.installations).toHaveLength(1)
    expect(inventory.installations[0]?.providers).toEqual(['agent-skills', 'claude'])
    expect(inventory.installations[0]?.topology).toBe('canonical-copy')
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it('deduplicates aliases within an unsupported topology while still updating the canonical copy', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const shared = await test.writeSkill(join(test.root, 'shared'), test.currentMarkdown)
    const repos = await Promise.all(
      ['one', 'two'].map(async (id) => {
        const repoPath = join(test.root, `repo-${id}`)
        const root = join(repoPath, '.agents', 'skills')
        await mkdir(root, { recursive: true })
        await symlink(shared, join(root, 'orca-cli'), linkType)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scan reads only id and path.
        return { id, path: repoPath } as Repo
      })
    )

    const inventory = await test.scan({ repos })

    expect(inventory.installations.filter((entry) => entry.topology === 'repo-scope')).toHaveLength(
      1
    )
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it('keeps an unreadable home placement visible and the name skipped', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const inaccessiblePath = join(test.homeDir, '.codex', 'skills', 'orca-cli')

    const inventory = await inventorySkillFreshness({
      homeDir: test.homeDir,
      repos: [],
      resourceRoot: test.resourceRoot,
      stateHome: null,
      candidateLstat: async (path) => {
        if (path === inaccessiblePath) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
        return import('node:fs/promises').then(({ lstat }) => lstat(path))
      }
    })

    expect(inventory.installations.map((entry) => [entry.topology, entry.status])).toEqual([
      ['canonical-copy', 'outdated'],
      ['broken-link', 'inaccessible']
    ])
    // Why: `skills add` would write through that placement for the codex target.
    expect(inventory.eligibleUpdateNames).toEqual([])
  })

  it('does not lose an inaccessible known repository placement', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const repoPath = join(test.root, 'repo')
    const inaccessiblePath = join(repoPath, '.agents', 'skills', 'orca-cli')

    const inventory = await inventorySkillFreshness({
      homeDir: test.homeDir,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scan reads only id and path.
      repos: [{ id: 'repo', path: repoPath } as Repo],
      resourceRoot: test.resourceRoot,
      stateHome: null,
      candidateLstat: async (path) => {
        if (path === inaccessiblePath) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
        return import('node:fs/promises').then(({ lstat }) => lstat(path))
      }
    })

    expect(inventory.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unresolvedPath: inaccessiblePath,
          topology: 'repo-scope',
          status: 'inaccessible'
        })
      ])
    )
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it.each([
    ['repo', 'repo-scope'],
    ['plugin', 'plugin-cache']
  ] as const)(
    'keeps an official %s placement informational without withholding the update',
    async (kind, topology) => {
      const test = await fixture()
      await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
      let repos: Repo[] = []
      if (kind === 'repo') {
        const repoPath = join(test.root, 'repo')
        await test.writeSkill(join(repoPath, '.agents', 'skills'), test.currentMarkdown)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scan reads only id and path.
        repos = [{ id: 'repo', path: repoPath } as Repo]
      } else {
        await test.writeSkill(
          join(test.homeDir, '.codex', 'plugins', 'cache', 'vendor', 'skills'),
          test.currentMarkdown
        )
      }

      const inventory = await test.scan({ repos })

      expect(inventory.installations.some((entry) => entry.topology === topology)).toBe(true)
      expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
    }
  )

  it('keeps another ecosystem’s same-name plugin skill out of the badge', async () => {
    // Why: Codex ships its own `computer-use` plugin (#10633). Orca never writes plugin
    // caches and cannot tell an old release from another vendor's skill.
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.currentMarkdown)
    const pluginRoot = join(
      test.homeDir,
      '.codex',
      'plugins',
      'cache',
      'openai-bundled',
      'orca-cli'
    )
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(join(pluginRoot, 'SKILL.md'), '---\nname: orca-cli\n---\n\nAnother tool.\n')

    const inventory = await test.scan()

    expect(inventory.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unresolvedPath: pluginRoot, topology: 'plugin-cache' })
      ])
    )
    expect(inventory.eligibleUpdateNames).toEqual([])
    expect(getSkillFreshnessDisplayStatus(inventory, 'orca-cli')).toBe('up-to-date')
  })

  it('does not classify an empty plugin-cache directory as a skill', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.currentMarkdown)
    const emptyRoot = join(test.homeDir, '.codex', 'plugins', 'cache', 'vendor', 'orca-cli')
    await mkdir(emptyRoot, { recursive: true })

    const inventory = await test.scan()

    expect(inventory.installations.some((entry) => entry.unresolvedPath === emptyRoot)).toBe(false)
  })

  it('reports the repository scan limit without withholding the global update', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const repos = Array.from(
      { length: MAXIMUM_REPOSITORY_SKILL_ROOTS / 2 + 1 },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scan reads only id and path.
      (_, index) => ({ id: `repo-${index}`, path: join(test.root, `repo-${index}`) }) as Repo
    )

    const inventory = await test.scan({ repos })

    expect(inventory.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ errorCategory: 'repository-scan-limit', status: 'inaccessible' })
      ])
    )
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it('scans a real-shaped plugin cache completely and leaves eligibility unchanged', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.oldMarkdown)
    const packageRoot = join(
      test.homeDir,
      '.codex',
      'plugins',
      'cache',
      'openai-bundled',
      'orca-cli',
      '1.0.0'
    )
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await writeFile(join(packageRoot, '.codex-plugin', 'plugin.json'), '{"skills":"./skills/"}\n')
    const pluginSkill = await test.writeSkill(join(packageRoot, 'skills'), test.currentMarkdown)
    await mkdir(join(pluginSkill, 'templates', 'starter', 'examples', 'd1', 'app', 'api'), {
      recursive: true
    })

    const inventory = await test.scan()

    expect(inventory.scanIssues).toEqual([])
    expect(inventory.installations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topology: 'plugin-cache', unresolvedPath: pluginSkill })
      ])
    )
    expect(inventory.eligibleUpdateNames).toEqual(['orca-cli'])
  })

  it('reports incomplete plugin coverage without inventing per-skill installations', async () => {
    const test = await fixture()
    await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.currentMarkdown)
    const pluginCache = join(test.homeDir, '.codex', 'plugins', 'cache')
    await mkdir(join(pluginCache, ...Array.from({ length: 11 }, (_, index) => `level-${index}`)), {
      recursive: true
    })

    const inventory = await test.scan()

    expect(inventory.installations).toHaveLength(1)
    expect(inventory.installations[0]).toMatchObject({
      name: 'orca-cli',
      status: 'current',
      topology: 'canonical-copy'
    })
    expect(inventory.scanIssues).toEqual([
      expect.objectContaining({
        rootId: 'codex-plugin-cache',
        sourceLabel: 'Codex plugin cache',
        reason: 'depth-limit',
        errorCode: null
      })
    ])
  })

  it.skipIf(process.platform === 'win32')(
    'invents no installations when the plugin cache trips the entry budget (#10918)',
    async () => {
      const test = await fixture()
      await test.writeSkill(join(test.homeDir, '.agents', 'skills'), test.currentMarkdown)
      const pluginCache = join(test.homeDir, '.codex', 'plugins', 'cache')
      await mkdir(pluginCache, { recursive: true })
      const entries = Array.from({ length: MAXIMUM_PLUGIN_SCAN_ENTRIES + 1 }, (_, index) =>
        join(pluginCache, `entry-${index}`)
      )
      for (let index = 0; index < entries.length; index += 512) {
        await Promise.all(entries.slice(index, index + 512).map((path) => writeFile(path, '')))
      }

      const inventory = await test.scan()

      expect(inventory.scanIssues).toEqual([
        expect.objectContaining({
          rootId: 'codex-plugin-cache',
          path: pluginCache,
          reason: 'entry-limit',
          errorCode: null
        })
      ])
      expect(inventory.installations).toEqual([
        expect.objectContaining({ name: 'orca-cli', status: 'current', topology: 'canonical-copy' })
      ])
    },
    90_000
  )
})
