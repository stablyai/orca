import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearConfiguredWorktreeSharedDirectoriesCacheForTests,
  getConfiguredWorktreeSharedDirectories,
  getWorktreeSharedLinkPaths,
  resolveWorktreeSharedDirectories,
  resolveWorktreeSharedLinkPaths
} from './worktree-shared-directories'
import {
  createWorktreeSharedPaths,
  findExistingWorktreeSymlinkPaths
} from '../ipc/worktree-symlinks'
import { assertWorktreeCleanForRemoval } from './worktree'
import { getStatus } from './status'
import { refreshLocalOrcaYamlSnapshot } from './orca-yaml-snapshot-store'
import { setFilesystemHostReadClientForTests } from '../filesystem-host/filesystem-host-read-authority'

beforeEach(() => {
  setFilesystemHostReadClientForTests({
    canonicalizePath: (path) => realpath(path),
    readOrcaYaml: (path) => readFile(path, 'utf8'),
    readKeybindings: async () => {
      throw new Error('unused')
    },
    readSnapshotFile: async () => Buffer.from(''),
    prepareRateLimitPtyCwd: async (path) => path
  })
})

afterEach(() => {
  setFilesystemHostReadClientForTests(null)
})

const git = (args: string[], cwd: string): void => {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull
    }
  })
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

  it('returns the configured names without existence or gitignore filtering', async () => {
    // Why: neither directory exists, yet removal still needs both names to
    // recognize and unlink the symlinks a previous creation left behind.
    writeFileSync(
      join(repo, 'orca.yaml'),
      'worktree:\n  sharedDirectories:\n    - node_modules\n    - .cache\n'
    )
    await refreshLocalOrcaYamlSnapshot(repo)

    expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual(['node_modules', '.cache'])
  })

  it('combines live per-user paths with cached repo configuration', async () => {
    writeFileSync(join(repo, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - node_modules\n')
    await refreshLocalOrcaYamlSnapshot(repo)

    expect(getWorktreeSharedLinkPaths({ path: repo, symlinkPaths: ['.cache'] })).toEqual([
      '.cache',
      'node_modules'
    ])
  })

  it('refreshes repo configuration before resolving destructive-cleanup paths', async () => {
    writeFileSync(join(repo, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - old-cache\n')
    await refreshLocalOrcaYamlSnapshot(repo)
    writeFileSync(join(repo, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - current-cache\n')

    await expect(
      resolveWorktreeSharedLinkPaths({ path: repo, symlinkPaths: ['user-cache'] })
    ).resolves.toEqual(['user-cache', 'old-cache', 'current-cache'])
  })

  it('returns [] when orca.yaml is absent or has no worktree key', async () => {
    await refreshLocalOrcaYamlSnapshot(repo)
    expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual([])

    writeFileSync(join(repo, 'orca.yaml'), 'scripts:\n  setup: pnpm install\n')
    await refreshLocalOrcaYamlSnapshot(repo)
    expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual([])
  })

  it('keeps status reads memory-only until an explicit refresh', async () => {
    writeFileSync(join(repo, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - node_modules\n')
    await refreshLocalOrcaYamlSnapshot(repo)
    expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual(['node_modules'])

    writeFileSync(join(repo, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - .cache\n')

    expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual(['node_modules'])
    await refreshLocalOrcaYamlSnapshot(repo)
    expect(getConfiguredWorktreeSharedDirectories(repo)).toEqual(['.cache'])
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
