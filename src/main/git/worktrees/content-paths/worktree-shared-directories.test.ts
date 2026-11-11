import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearConfiguredWorktreeSharedDirectoriesCacheForTests,
  getConfiguredWorktreeSharedDirectories,
  resolveWorktreeSharedDirectories
} from './worktree-shared-directories'
import { createWorktreeSharedPaths } from '../../../ipc/worktree-symlinks'
import { findExistingWorktreeSymlinkPaths } from './worktree-symlink-detection'
import { assertWorktreeCleanForRemoval } from '../removal/worktree-removal-preflight'

// An empty config file works with Windows Git (os.devNull does not) and isolates the production runner too.
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
})

// Directory-only ignore rules hide the primary directory, but not its worktree symlink.
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

  // Pass actual resolver output to status so path spelling cannot drift across the seam.

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
    await expect(removal).rejects.toMatchObject({ stdout: '?? precious.txt' })
  })

  // NUL records preserve C-quoted Unicode names and names with spaces for exact matching.
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
})
