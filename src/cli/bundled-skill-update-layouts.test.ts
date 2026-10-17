import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bundledSkillVerdict,
  type BundledSkillLeaveReason,
  type BundledSkillLocationAction,
  type BundledSkillVerdict
} from '../shared/skill-freshness'
import type { BundledOrcaSkillPackage } from '../main/skills/bundled-orca-skill-packages'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem
} from '../main/skills/skill-install-filesystem'
import {
  bundledOrcaSkillManifest,
  installBundledOrcaSkills
} from '../main/skills/bundled-orca-skill-install'
import { planBundledOrcaSkills } from '../main/skills/bundled-orca-skill-plan'
import { resolveEnvironmentSkillProviderRoots } from '../main/skills/skill-provider-runtime-roots'
import {
  bundledSkillsStillToUpdate,
  scanBundledSkillFreshness,
  updateBundledSkills
} from '../main/skills/bundled-skill-freshness'
import { main } from './index'

// One table over the layouts real homes carry, asserting the app's verdict, the CLI's
// --dry-run and the run itself all come from — and agree with — the installer's plan.

const OLD_TEXT = '---\nname: test-skill\ndescription: Old\n---\n\nOld body\n'
const NEW_TEXT = '---\nname: test-skill\ndescription: New\n---\n\nNew body\n'
const NAME = 'test-skill'

const packages = vi.hoisted(() => {
  const value: BundledOrcaSkillPackage[] = []
  return { value }
})
vi.mock('../main/skills/bundled-orca-skill-packages', () => ({
  get BUNDLED_ORCA_SKILL_PACKAGES() {
    return packages.value
  }
}))
vi.mock('./bundled-skill-guides.js', () => ({
  BUNDLED_SKILL_GUIDES: [
    { name: NAME, description: 'Test.', markdown: '', fullMarkdown: '', aliases: [] }
  ]
}))
vi.mock('./runtime-client', async () => {
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('./runtime/types.js')
  return {
    RuntimeClient: class {},
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn()
  }
})

function entry(text: string, releasedDigests: string[]): BundledOrcaSkillPackage {
  return { name: NAME, files: [{ path: 'SKILL.md', text }], releasedDigests }
}
const OLD_DIGEST = bundledOrcaSkillManifest(entry(OLD_TEXT, [])).packageDigest
const NEW_DIGEST = bundledOrcaSkillManifest(entry(NEW_TEXT, [])).packageDigest
const OLD_BUILD = entry(OLD_TEXT, [OLD_DIGEST])
const NEW_BUILD = entry(NEW_TEXT, [OLD_DIGEST, NEW_DIGEST])

type Home = {
  root: string
  home: string
  shared: string
  claude: string
  orcaState: string
}

const directories: string[] = []

async function makeHome(): Promise<Home> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-layouts-'))
  directories.push(root)
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  return {
    root,
    home,
    shared: join(home, '.agents', 'skills', NAME),
    claude: join(home, '.claude', 'skills', NAME),
    orcaState: join(root, 'orca-state')
  }
}

// Why the CLI's own identity: the app and `orca skills` must read the same receipts here.
function installInput(home: Home, filesystem?: SkillInstallFilesystem) {
  return {
    scope: 'global' as const,
    homeDirectory: home.home,
    orcaStateDirectory: home.orcaState,
    detectedProviders: ['claude'],
    providerRootOverrides: resolveEnvironmentSkillProviderRoots(),
    hostIdentity: 'orca-cli',
    destinationIdentity: 'global:orca-cli',
    ...(filesystem ? { filesystem } : {})
  }
}

async function writeCopy(path: string, text: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), text)
}

async function writeOrcaLock(home: Home): Promise<void> {
  await mkdir(join(home.home, '.agents'), { recursive: true })
  await writeFile(
    join(home.home, '.agents', '.skill-lock.json'),
    JSON.stringify({ version: 3, skills: { [NAME]: { source: 'stablyai/orca' } } })
  )
}

async function installWithOrca(home: Home, filesystem?: SkillInstallFilesystem): Promise<void> {
  packages.value = [OLD_BUILD]
  const [result] = await installBundledOrcaSkills([NAME], installInput(home, filesystem))
  expect(result.status).toBe('installed')
}

// Why a symlink stand-in: it exercises the alias branch a WSL guest filesystem takes.
const guestAliasFilesystem: SkillInstallFilesystem = {
  ...nativeSkillInstallFilesystem,
  createAlias: async (canonicalPath, destinationPath) => {
    await mkdir(dirname(destinationPath), { recursive: true })
    await symlink(canonicalPath, destinationPath, 'dir')
  },
  aliasTargets: async (canonicalPath, destinationPath) =>
    (await readlink(destinationPath).catch(() => null)) === canonicalPath
}

type Expected = {
  verdict: BundledSkillVerdict
  /** Action per location path, keyed by a label from the home. */
  locations: [
    keyof Pick<Home, 'shared' | 'claude'>,
    BundledSkillLocationAction,
    BundledSkillLeaveReason?
  ][]
}

type Layout = {
  name: string
  arrange: (home: Home) => Promise<void>
  expected: Expected
  /** Paths outside the plan that the run must leave byte-identical. */
  untouched?: (home: Home) => string[]
  filesystem?: SkillInstallFilesystem
  /** Unix permissions are what make a folder read-only here. */
  posixOnly?: boolean
}

const LAYOUTS: Layout[] = [
  {
    name: 'npx shared copy (lock stablyai/orca)',
    arrange: async (home) => {
      await writeOrcaLock(home)
      await writeCopy(home.shared, OLD_TEXT)
      await mkdir(join(home.home, '.claude', 'skills'), { recursive: true })
      await symlink(home.shared, home.claude, 'dir')
    },
    expected: {
      verdict: 'update',
      locations: [
        ['shared', 'update'],
        ['claude', 'keep']
      ]
    }
  },
  {
    name: 'npx single-agent copy (real folder in ~/.claude/skills, no shared copy)',
    arrange: async (home) => {
      await writeOrcaLock(home)
      await writeCopy(home.claude, OLD_TEXT)
    },
    expected: {
      verdict: 'update',
      locations: [
        ['shared', 'install'],
        ['claude', 'replace']
      ]
    }
  },
  {
    name: 'installed by an earlier Orca',
    arrange: (home) => installWithOrca(home),
    expected: {
      verdict: 'update',
      locations: [
        ['shared', 'update'],
        ['claude', 'keep']
      ]
    }
  },
  {
    name: 'installed by an earlier Orca, then edited',
    arrange: async (home) => {
      await installWithOrca(home)
      await writeFile(join(home.shared, 'SKILL.md'), 'mine\n')
    },
    expected: { verdict: 'attention', locations: [['shared', 'leave', 'local-changes']] }
  },
  {
    name: 'agent folder is a link out of Orca’s folders',
    arrange: async (home) => {
      await installWithOrca(home)
      await rm(home.claude)
      await writeCopy(join(home.root, 'elsewhere', NAME), OLD_TEXT)
      await symlink(join(home.root, 'elsewhere', NAME), home.claude, 'dir')
    },
    expected: {
      verdict: 'update',
      locations: [
        ['shared', 'update'],
        ['claude', 'leave', 'link-not-managed']
      ]
    },
    untouched: (home) => [join(home.root, 'elsewhere', NAME)]
  },
  {
    name: 'agent folder is a broken link Orca did not make',
    arrange: async (home) => {
      await writeOrcaLock(home)
      await writeCopy(home.shared, OLD_TEXT)
      await mkdir(join(home.home, '.claude', 'skills'), { recursive: true })
      await symlink(join(home.root, 'gone', NAME), home.claude, 'dir')
    },
    expected: {
      verdict: 'update',
      locations: [
        ['shared', 'update'],
        ['claude', 'leave', 'link-not-managed']
      ]
    }
  },
  {
    name: 'plugin-managed copy only',
    arrange: async (home) => {
      await writeCopy(join(home.home, '.claude', 'plugins', 'cache', 'vendor', NAME), OLD_TEXT)
    },
    expected: {
      verdict: 'absent',
      locations: [
        ['shared', 'install'],
        ['claude', 'link']
      ]
    },
    untouched: (home) => [join(home.home, '.claude', 'plugins', 'cache', 'vendor', NAME)]
  },
  {
    name: 'shared folder is read-only',
    posixOnly: true,
    arrange: async (home) => {
      await installWithOrca(home)
      await chmod(join(home.home, '.agents', 'skills'), 0o555)
    },
    expected: { verdict: 'attention', locations: [['shared', 'leave', 'read-only']] }
  },
  {
    name: 'project copy beside a current global install',
    arrange: async (home) => {
      packages.value = [NEW_BUILD]
      await installBundledOrcaSkills([NAME], installInput(home))
      await writeCopy(join(home.root, 'project', '.claude', 'skills', NAME), OLD_TEXT)
    },
    expected: {
      verdict: 'current',
      locations: [
        ['shared', 'keep'],
        ['claude', 'keep']
      ]
    },
    untouched: (home) => [join(home.root, 'project', '.claude', 'skills', NAME)]
  },
  {
    name: 'WSL guest alias installed by an earlier Orca',
    filesystem: guestAliasFilesystem,
    arrange: (home) => installWithOrca(home, guestAliasFilesystem),
    expected: {
      verdict: 'update',
      locations: [
        ['shared', 'update'],
        ['claude', 'keep']
      ]
    }
  }
]

async function snapshot(path: string): Promise<string> {
  const stat = await lstat(path).catch(() => null)
  if (!stat) {
    return 'missing'
  }
  if (stat.isSymbolicLink()) {
    return `link:${await readlink(path)}`
  }
  return `dir:${await readFile(join(path, 'SKILL.md'), 'utf8').catch(() => '?')}`
}

async function cliDryRunPlan(home: Home): Promise<unknown> {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await main(
      ['skills', 'update', '--skill', NAME, '--agent', 'claude', '--dry-run', '--json'],
      home.home
    )
    return JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join('')).plan
  } finally {
    stdout.mockRestore()
  }
}

beforeEach(() => {
  for (const name of [
    'CLAUDE_CONFIG_DIR',
    'GROK_HOME',
    'HERMES_HOME',
    'CODEX_HOME',
    'XDG_STATE_HOME',
    'ORCA_CLI_CWD'
  ]) {
    vi.stubEnv(name, '')
  }
})

afterEach(async () => {
  vi.unstubAllEnvs()
  process.exitCode = undefined
  for (const directory of directories.splice(0)) {
    await chmod(join(directory, 'home', '.agents', 'skills'), 0o755).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

describe('Orca skill update plan across real layouts', () => {
  const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0
  it.each(LAYOUTS.map((layout) => [layout.name, layout] as const))('%s', async (_name, layout) => {
    if (layout.posixOnly && !canChmod) {
      return
    }
    const home = await makeHome()
    await layout.arrange(home)
    packages.value = [NEW_BUILD]
    vi.stubEnv('HOME', home.home)
    vi.stubEnv('USERPROFILE', home.home)
    vi.stubEnv('ORCA_USER_DATA_PATH', home.orcaState)
    const plan = (names: readonly string[]) =>
      planBundledOrcaSkills(names, installInput(home, layout.filesystem))

    // The app's verdict is the installer's plan.
    const [appPlan] = await plan([NAME])
    expect(bundledSkillVerdict(appPlan)).toBe(layout.expected.verdict)
    expect(
      appPlan.locations.map((location) => [location.path, location.action, location.reason])
    ).toEqual(layout.expected.locations.map(([at, action, reason]) => [home[at], action, reason]))
    const scan = await scanBundledSkillFreshness(plan)
    expect(scan.skills).toEqual(layout.expected.verdict === 'absent' ? [] : [appPlan])

    // `orca skills update --dry-run` prints the same plan (the CLI has no guest filesystem).
    if (!layout.filesystem) {
      expect(await cliDryRunPlan(home)).toEqual(scan.skills)
    }

    // The app's Update runs exactly that plan.
    const left = appPlan.locations.filter((location) => location.action === 'leave')
    const watched = [...left.map((location) => location.path), ...(layout.untouched?.(home) ?? [])]
    const before = await Promise.all(watched.map(snapshot))
    const install = vi.fn((names: string[]) =>
      installBundledOrcaSkills(names, installInput(home, layout.filesystem))
    )
    await updateBundledSkills([NAME], { plan, install })

    expect(install).toHaveBeenCalledTimes(layout.expected.verdict === 'update' ? 1 : 0)
    expect(await Promise.all(watched.map(snapshot))).toEqual(before)
    expect(await bundledSkillsStillToUpdate([NAME], plan)).toEqual([])
    if (layout.expected.verdict === 'update') {
      expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
      const [after] = await plan([NAME])
      expect(after.locations.filter((location) => location.action !== 'leave')).toEqual(
        after.locations
          .filter((location) => location.action !== 'leave')
          .map((location) => ({ ...location, action: 'keep' }))
      )
    }
  })
})
