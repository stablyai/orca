import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearConfiguredWorktreeSharedDirectoriesCacheForTests,
  getConfiguredWorktreeSharedDirectories,
  getWorktreeSharedLinkPaths,
  resolveWorktreeSharedDirectories
} from './worktree-shared-directories'
import {
  createWorktreeSharedPaths,
  findExistingWorktreeSymlinkPaths
} from '../ipc/worktree-symlinks'
import { assertWorktreeCleanForRemoval } from './worktree'
import { getStatus } from './status'

// Why an empty file and not `os.devNull`: that constant is `\\.\nul` on win32, which
// Git normalizes to `//./nul` and rejects — `fatal: unable to access '//./nul': Invalid
// argument`. Every git call in this file then threw. POSIX resolves it to /dev/null,
// which Git accepts, so CI never saw it. An empty file works on every platform and
// matches how skill-git-tree-identity and skill-windows-workspace already isolate.
//
// Why process.env and not just this helper's env: resolveWorktreeSharedDirectories
// runs its own `git check-ignore` through the production runner, which inherits
// process.env. Overriding only the setup helper left the code under test reading the
// host's real config, so a developer with core.excludesFile set saw a fixture that is
// not gitignored come back as ignored.
let gitConfigRoot: string
let previousGitConfigGlobal: string | undefined
let previousGitConfigNosystem: string | undefined

beforeAll(() => {
  gitConfigRoot = mkdtempSync(join(tmpdir(), 'orca-shared-dirs-gitconfig-'))
  const emptyGlobalGitConfig = join(gitConfigRoot, 'global.gitconfig')
  writeFileSync(emptyGlobalGitConfig, '')
  previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
  previousGitConfigNosystem = process.env.GIT_CONFIG_NOSYSTEM
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalGitConfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterAll(() => {
  restoreGitEnv('GIT_CONFIG_GLOBAL', previousGitConfigGlobal)
  restoreGitEnv('GIT_CONFIG_NOSYSTEM', previousGitConfigNosystem)
  rmSync(gitConfigRoot, { recursive: true, force: true })
})

function restoreGitEnv(
  name: 'GIT_CONFIG_GLOBAL' | 'GIT_CONFIG_NOSYSTEM',
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

const git = (args: string[], cwd: string): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('resolveWorktreeSharedDirectories', () => {
  let repo: string
  let warn: ReturnType<typeof vi.spyOn>

  const writeOrcaYaml = (body: string): void => {
    writeFileSync(join(repo, 'orca.yaml'), body)
  }

  beforeEach(() => {
    clearConfiguredWorktreeSharedDirectoriesCacheForTests()
    repo = mkdtempSync(join(tmpdir(), 'orca-shared-dirs-'))
    git(['init', '-q'], repo)
    git(['config', 'user.email', 'test@example.com'], repo)
    git(['config', 'user.name', 'Test'], repo)
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.cache\n')
    writeFileSync(join(repo, 'README.md'), '# tracked\n')
    git(['add', '.gitignore', 'README.md'], repo)
    git(['commit', '-qm', 'init'], repo)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns gitignored directories listed under worktree.sharedDirectories', async () => {
    mkdirSync(join(repo, 'node_modules'))
    mkdirSync(join(repo, '.cache'))
    writeOrcaYaml('worktree:\n  sharedDirectories:\n    - node_modules\n    - .cache\n')

    expect(await resolveWorktreeSharedDirectories(repo)).toEqual(['.cache', 'node_modules'])
  })

  it('returns [] when orca.yaml is absent', async () => {
    mkdirSync(join(repo, 'node_modules'))

    expect(await resolveWorktreeSharedDirectories(repo)).toEqual([])
  })

  it('returns [] when orca.yaml has no worktree key', async () => {
    mkdirSync(join(repo, 'node_modules'))
    writeOrcaYaml('scripts:\n  setup: pnpm install\n')

    expect(await resolveWorktreeSharedDirectories(repo)).toEqual([])
  })

  it('skips a directory that is not gitignored', async () => {
    mkdirSync(join(repo, 'shared-but-tracked'))
    writeOrcaYaml('worktree:\n  sharedDirectories:\n    - shared-but-tracked\n')

    expect(await resolveWorktreeSharedDirectories(repo)).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('only gitignored directories'))
  })

  it('skips a listed path that is a file, not a directory', async () => {
    writeFileSync(join(repo, '.cache'), 'not a dir')
    writeOrcaYaml('worktree:\n  sharedDirectories:\n    - .cache\n')

    expect(await resolveWorktreeSharedDirectories(repo)).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('must be directories'))
  })

  it('skips entries that are absent from the primary checkout', async () => {
    writeOrcaYaml('worktree:\n  sharedDirectories:\n    - node_modules\n')

    expect(await resolveWorktreeSharedDirectories(repo)).toEqual([])
  })

  it('drops unsafe entries before touching the filesystem', async () => {
    mkdirSync(join(repo, 'node_modules'))
    writeOrcaYaml(
      [
        'worktree:',
        '  sharedDirectories:',
        '    - ../escape',
        '    - /etc',
        '    - .git',
        '    - .git/hooks',
        '    - node_modules',
        ''
      ].join('\n')
    )

    expect(await resolveWorktreeSharedDirectories(repo)).toEqual(['node_modules'])
  })

  it('normalizes trailing slashes, ./ prefixes and duplicates', async () => {
    mkdirSync(join(repo, 'node_modules'))
    writeOrcaYaml(
      'worktree:\n  sharedDirectories:\n    - node_modules/\n    - ./node_modules\n    - node_modules\n'
    )

    expect(await resolveWorktreeSharedDirectories(repo)).toEqual(['node_modules'])
  })

  it('returns [] for a malformed sharedDirectories value instead of throwing', async () => {
    mkdirSync(join(repo, 'node_modules'))
    writeOrcaYaml('worktree:\n  sharedDirectories: node_modules\n')

    expect(await resolveWorktreeSharedDirectories(repo)).toEqual([])
  })

  it('resolves nested directories anchored at the repo root', async () => {
    mkdirSync(join(repo, 'apps', 'web', '.cache'), { recursive: true })
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.cache\napps/web/.cache\n')
    writeOrcaYaml('worktree:\n  sharedDirectories:\n    - apps/web/.cache\n')

    expect(await resolveWorktreeSharedDirectories(repo)).toEqual(['apps/web/.cache'])
  })
})

describe('getConfiguredWorktreeSharedDirectories', () => {
  let repo: string

  beforeEach(() => {
    clearConfiguredWorktreeSharedDirectoriesCacheForTests()
    repo = mkdtempSync(join(tmpdir(), 'orca-shared-dirs-config-'))
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the configured names without existence or gitignore filtering', () => {
    // Why: neither directory exists, yet removal still needs both names to
    // recognize and unlink the symlinks a previous creation left behind.
    writeFileSync(
      join(repo, 'orca.yaml'),
      'worktree:\n  sharedDirectories:\n    - node_modules\n    - .cache\n'
    )

    expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual(['node_modules', '.cache'])
  })

  it('combines live per-user paths with cached repo configuration', () => {
    writeFileSync(join(repo, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - node_modules\n')

    expect(getWorktreeSharedLinkPaths({ path: repo, symlinkPaths: ['.cache'] })).toEqual([
      '.cache',
      'node_modules'
    ])
  })

  it('returns [] when orca.yaml is absent or has no worktree key', () => {
    expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual([])

    writeFileSync(join(repo, 'orca.yaml'), 'scripts:\n  setup: pnpm install\n')
    clearConfiguredWorktreeSharedDirectoriesCacheForTests()
    expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual([])
  })

  it('caches repeated status polls but refreshes changed configuration', () => {
    vi.useFakeTimers()
    try {
      writeFileSync(
        join(repo, 'orca.yaml'),
        'worktree:\n  sharedDirectories:\n    - node_modules\n'
      )
      expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual(['node_modules'])

      writeFileSync(join(repo, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - .cache\n')

      expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual(['node_modules'])
      vi.advanceTimersByTime(30_001)
      expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual(['.cache'])
    } finally {
      vi.useRealTimers()
    }
  })
})

// Why: `node_modules/` is a directory-only ignore rule. It matches the primary's
// real directory, so the shared directory resolves, but never the worktree's
// symlink — Git reports that link as untracked and refuses a non-force removal
// unless deletion is told to tolerate it.
describe('shared directories and worktree removal', () => {
  let root: string
  let primary: string
  let worktree: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-shared-dirs-removal-'))
    primary = join(root, 'primary')
    worktree = join(root, 'worktree')
    mkdirSync(primary)
    git(['init', '-q', '-b', 'main'], primary)
    git(['config', 'user.email', 'test@example.com'], primary)
    git(['config', 'user.name', 'Test'], primary)
    writeFileSync(join(primary, '.gitignore'), 'node_modules/\n')
    writeFileSync(
      join(primary, 'orca.yaml'),
      'worktree:\n  sharedDirectories:\n    - node_modules\n'
    )
    git(['add', '-A'], primary)
    git(['commit', '-qm', 'init'], primary)
    mkdirSync(join(primary, 'node_modules'))
    git(['worktree', 'add', '-q', worktree, '-b', 'feature'], primary)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('leaves a worktree removable without force after sharing a directory', async () => {
    await createWorktreeSharedPaths(
      primary,
      worktree,
      await resolveWorktreeSharedDirectories(primary)
    )
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true)

    const ignoredLinkedPaths = await findExistingWorktreeSymlinkPaths(
      worktree,
      getConfiguredWorktreeSharedDirectories(primary)
    )

    expect(ignoredLinkedPaths).toEqual(['node_modules'])
    await expect(
      assertWorktreeCleanForRemoval(worktree, false, { ignoredUntrackedPaths: ignoredLinkedPaths })
    ).resolves.toBeUndefined()
  })

  // Why: the halves are tested apart — resolver output here, a hardcoded
  // `['node_modules']` in the status tests. This pins the seam between them, so a
  // resolver that ever returns a differently-spelled path can't leave the link
  // showing as a phantom untracked row.
  it('leaves status clean when the resolved directory is fed back as a shared link', async () => {
    await createWorktreeSharedPaths(
      primary,
      worktree,
      await resolveWorktreeSharedDirectories(primary)
    )

    const status = await getStatus(worktree, {
      sharedLinkPaths: getWorktreeSharedLinkPaths({ path: primary })
    })

    expect(status.entries).toEqual([])
  })

  // Why: `-z` output is NUL-delimited and `.trim()` leaves interior NULs, so the
  // raw stdout reached the user as `?? node_modules<NUL>?? precious.txt<NUL>` —
  // raw control bytes in a message, listing the very link this feature exists to
  // suppress. The error must name only what the user can actually act on.
  it('reports only genuine blockers in the removal error, with no NUL bytes', async () => {
    await createWorktreeSharedPaths(
      primary,
      worktree,
      await resolveWorktreeSharedDirectories(primary)
    )
    writeFileSync(join(worktree, 'precious.txt'), 'unsaved work')

    const removal = assertWorktreeCleanForRemoval(worktree, false, {
      ignoredUntrackedPaths: await findExistingWorktreeSymlinkPaths(
        worktree,
        getConfiguredWorktreeSharedDirectories(primary)
      )
    })

    await expect(removal).rejects.toThrow('uncommitted or untracked')
    // Why an exact match: it proves both halves at once — no interior NUL, and
    // the tolerated `node_modules` link absent from what the user is told to fix.
    await expect(removal).rejects.toMatchObject({ stdout: '?? precious.txt' })
  })

  // Why `-z` is used at all: Git C-quotes non-ASCII paths under `--porcelain`,
  // so a byte-for-byte comparison against the configured entry would miss and the
  // link would read as a blocker. A space alone is not quoted but is the case a
  // naive whitespace split would break.
  it('tolerates shared directories whose names have a space or non-ASCII characters', async () => {
    const names = ['my shared dir', 'ライブラリ']
    for (const name of names) {
      mkdirSync(join(primary, name))
    }
    writeFileSync(join(primary, '.gitignore'), `node_modules/\n${names.join('\n')}\n`)
    writeFileSync(
      join(primary, 'orca.yaml'),
      `worktree:\n  sharedDirectories:\n${names.map((name) => `    - ${name}`).join('\n')}\n`
    )
    clearConfiguredWorktreeSharedDirectoriesCacheForTests()

    await createWorktreeSharedPaths(
      primary,
      worktree,
      await resolveWorktreeSharedDirectories(primary)
    )

    const ignoredLinkedPaths = await findExistingWorktreeSymlinkPaths(
      worktree,
      getConfiguredWorktreeSharedDirectories(primary)
    )

    expect(ignoredLinkedPaths).toEqual(expect.arrayContaining(names))
    await expect(
      assertWorktreeCleanForRemoval(worktree, false, { ignoredUntrackedPaths: ignoredLinkedPaths })
    ).resolves.toBeUndefined()
  })

  it('still refuses removal for real untracked changes next to a shared directory', async () => {
    await createWorktreeSharedPaths(
      primary,
      worktree,
      await resolveWorktreeSharedDirectories(primary)
    )
    writeFileSync(join(worktree, 'scratch.txt'), 'unsaved work')

    await expect(
      assertWorktreeCleanForRemoval(worktree, false, {
        ignoredUntrackedPaths: await findExistingWorktreeSymlinkPaths(
          worktree,
          getConfiguredWorktreeSharedDirectories(primary)
        )
      })
    ).rejects.toThrow('uncommitted or untracked')
  })
})
