import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileStat } from '../providers/types'
import {
  copyLocalWorktreeIncludeFiles,
  copyRemoteWorktreeIncludeFiles,
  parseWorktreeInclude
} from './worktree-include-copy'

const tempRoots: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo })
}

async function createRepo(): Promise<{ repo: string; worktree: string }> {
  const repo = await makeTempDir('orca-include-repo-')
  const worktree = await makeTempDir('orca-include-worktree-')
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  await writeFile(
    path.join(repo, '.gitignore'),
    ['.env.local', '.claude/settings.local.json', 'ignored-dir/', 'apps/*/.env.local'].join('\n')
  )
  await writeFile(path.join(repo, 'tracked.txt'), 'tracked content')
  git(repo, ['add', '.gitignore', 'tracked.txt'])
  git(repo, ['commit', '-q', '-m', 'initial'])
  return { repo, worktree }
}

async function writeIncludeFile(repo: string, lines: string[]): Promise<void> {
  await writeFile(path.join(repo, '.worktreeinclude'), lines.join('\n'))
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('parseWorktreeInclude', () => {
  it('ignores comments and blank lines and dedupes entries', () => {
    const parsed = parseWorktreeInclude(
      [
        '# local setup files',
        '',
        '  ',
        '.env.local',
        '.env.local',
        '  .claude/settings.local.json  '
      ].join('\n')
    )
    expect(parsed.entries).toEqual(['.env.local', '.claude/settings.local.json'])
    expect(parsed.malformed).toEqual([])
  })

  it('rejects absolute paths, traversal, and glob patterns as malformed', () => {
    const parsed = parseWorktreeInclude(
      [
        '/etc/passwd',
        'C:\\secrets\\key',
        '../outside.txt',
        'nested/../../outside.txt',
        'apps/*/.env.local',
        'what?.txt',
        'good/.env.local'
      ].join('\n')
    )
    expect(parsed.entries).toEqual(['good/.env.local'])
    expect(parsed.malformed).toEqual([
      '/etc/passwd',
      'C:\\secrets\\key',
      '../outside.txt',
      'nested/../../outside.txt',
      'apps/*/.env.local',
      'what?.txt'
    ])
  })

  it('normalizes backslash separators and redundant segments', () => {
    const parsed = parseWorktreeInclude('.claude\\settings.local.json\n./sub/./.env.local\n')
    expect(parsed.entries).toEqual(['.claude/settings.local.json', 'sub/.env.local'])
    expect(parsed.malformed).toEqual([])
  })

  it('rejects git pathspec-magic entries that would make git exit fatally', () => {
    const parsed = parseWorktreeInclude([':(icase).env.local', ':!secret', '.env.local'].join('\n'))
    expect(parsed.entries).toEqual(['.env.local'])
    expect(parsed.malformed).toEqual([':(icase).env.local', ':!secret'])
  })
})

describe('copyLocalWorktreeIncludeFiles', () => {
  it('returns undefined when no .worktreeinclude exists', async () => {
    const { repo, worktree } = await createRepo()
    await expect(copyLocalWorktreeIncludeFiles(repo, worktree)).resolves.toBeUndefined()
  })

  it('is a no-op for an empty .worktreeinclude', async () => {
    const { repo, worktree } = await createRepo()
    await writeIncludeFile(repo, ['# nothing yet', ''])
    await expect(copyLocalWorktreeIncludeFiles(repo, worktree)).resolves.toEqual({
      copied: [],
      skipped: []
    })
  })

  it('copies gitignored files, creating parent directories and preserving mode', async () => {
    const { repo, worktree } = await createRepo()
    await writeFile(path.join(repo, '.env.local'), 'SECRET=1')
    await mkdir(path.join(repo, '.claude'), { recursive: true })
    await writeFile(path.join(repo, '.claude', 'settings.local.json'), '{"enabled":false}')
    await chmod(path.join(repo, '.env.local'), 0o700)
    await writeIncludeFile(repo, ['.env.local', '.claude/settings.local.json'])

    const result = await copyLocalWorktreeIncludeFiles(repo, worktree)

    expect(result).toEqual({
      copied: ['.env.local', '.claude/settings.local.json'],
      skipped: []
    })
    await expect(readFile(path.join(worktree, '.env.local'), 'utf8')).resolves.toBe('SECRET=1')
    await expect(
      readFile(path.join(worktree, '.claude', 'settings.local.json'), 'utf8')
    ).resolves.toBe('{"enabled":false}')
    if (process.platform !== 'win32') {
      const mode = (await stat(path.join(worktree, '.env.local'))).mode & 0o777
      expect(mode).toBe(0o700)
    }
  })

  it('refuses tracked files and untracked files that are not gitignored', async () => {
    const { repo, worktree } = await createRepo()
    await writeFile(path.join(repo, 'untracked.txt'), 'untracked')
    await writeFile(path.join(repo, '.env.local'), 'SECRET=1')
    await writeIncludeFile(repo, ['tracked.txt', 'untracked.txt', '.env.local'])

    const result = await copyLocalWorktreeIncludeFiles(repo, worktree)

    expect(result).toEqual({
      copied: ['.env.local'],
      skipped: [
        { path: 'tracked.txt', reason: 'tracked' },
        { path: 'untracked.txt', reason: 'not-ignored' }
      ]
    })
    await expect(stat(path.join(worktree, 'tracked.txt'))).rejects.toThrow()
    await expect(stat(path.join(worktree, 'untracked.txt'))).rejects.toThrow()
  })

  it('skips entries that match an ignore pattern but are missing on disk', async () => {
    const { repo, worktree } = await createRepo()
    await writeIncludeFile(repo, ['.env.local'])

    await expect(copyLocalWorktreeIncludeFiles(repo, worktree)).resolves.toEqual({
      copied: [],
      skipped: [{ path: '.env.local', reason: 'missing' }]
    })
  })

  it('never overwrites an existing destination file', async () => {
    const { repo, worktree } = await createRepo()
    await writeFile(path.join(repo, '.env.local'), 'SECRET=from-repo')
    await writeFile(path.join(worktree, '.env.local'), 'SECRET=already-here')
    await writeIncludeFile(repo, ['.env.local'])

    const result = await copyLocalWorktreeIncludeFiles(repo, worktree)

    expect(result).toEqual({
      copied: [],
      skipped: [{ path: '.env.local', reason: 'destination-exists' }]
    })
    await expect(readFile(path.join(worktree, '.env.local'), 'utf8')).resolves.toBe(
      'SECRET=already-here'
    )
  })

  it('skips directories listed as entries', async () => {
    const { repo, worktree } = await createRepo()
    await mkdir(path.join(repo, 'ignored-dir'))
    await writeFile(path.join(repo, 'ignored-dir', 'file.txt'), 'x')
    await writeIncludeFile(repo, ['ignored-dir'])

    await expect(copyLocalWorktreeIncludeFiles(repo, worktree)).resolves.toEqual({
      copied: [],
      skipped: [{ path: 'ignored-dir', reason: 'not-a-file' }]
    })
  })

  it('treats malformed lines and per-file copy failures as non-fatal', async () => {
    const { repo, worktree } = await createRepo()
    await writeFile(path.join(repo, '.env.local'), 'SECRET=1')
    await mkdir(path.join(repo, '.claude'), { recursive: true })
    await writeFile(path.join(repo, '.claude', 'settings.local.json'), '{}')
    // Block the destination parent with a file so the nested copy fails.
    await writeFile(path.join(worktree, '.claude'), 'not a directory')
    await writeIncludeFile(repo, ['../escape.txt', '.claude/settings.local.json', '.env.local'])

    const result = await copyLocalWorktreeIncludeFiles(repo, worktree)

    expect(result?.copied).toEqual(['.env.local'])
    expect(result?.skipped).toEqual([
      { path: '../escape.txt', reason: 'malformed' },
      { path: '.claude/settings.local.json', reason: 'copy-failed' }
    ])
    await expect(readFile(path.join(worktree, '.env.local'), 'utf8')).resolves.toBe('SECRET=1')
  })

  it('refuses a symlinked source instead of dereferencing it out of the repo', async () => {
    // Symlink creation needs privilege on Windows; skip there.
    if (process.platform === 'win32') {
      return
    }
    const { repo, worktree } = await createRepo()
    const secretDir = await makeTempDir('orca-include-secret-')
    await writeFile(path.join(secretDir, 'id_rsa'), 'PRIVATE KEY')
    // A repo-committed symlink pointing at a host file outside the repo; the
    // manifest lists the link itself (a "leaf" symlink git will still
    // check-ignore, unlike a symlinked parent which git rejects outright).
    await symlink(path.join(secretDir, 'id_rsa'), path.join(repo, 'stolen-key'))
    await writeFile(
      path.join(repo, '.gitignore'),
      [
        '.env.local',
        '.claude/settings.local.json',
        'ignored-dir/',
        'apps/*/.env.local',
        'stolen-key'
      ].join('\n')
    )
    await writeIncludeFile(repo, ['stolen-key'])

    await expect(copyLocalWorktreeIncludeFiles(repo, worktree)).resolves.toEqual({
      copied: [],
      skipped: [{ path: 'stolen-key', reason: 'not-a-file' }]
    })
    await expect(stat(path.join(worktree, 'stolen-key'))).rejects.toThrow()
  })

  it('refuses to copy through a symlinked destination parent', async () => {
    if (process.platform === 'win32') {
      return
    }
    const { repo, worktree } = await createRepo()
    await mkdir(path.join(repo, '.claude'), { recursive: true })
    await writeFile(path.join(repo, '.claude', 'settings.local.json'), '{}')
    // Attacker-shaped worktree: `.claude` is a symlink to somewhere outside.
    const outside = await makeTempDir('orca-include-outside-')
    await symlink(outside, path.join(worktree, '.claude'))
    await writeIncludeFile(repo, ['.claude/settings.local.json'])

    await expect(copyLocalWorktreeIncludeFiles(repo, worktree)).resolves.toEqual({
      copied: [],
      skipped: [{ path: '.claude/settings.local.json', reason: 'not-a-file' }]
    })
    await expect(stat(path.join(outside, 'settings.local.json'))).rejects.toThrow()
  })
})

describe('copyRemoteWorktreeIncludeFiles', () => {
  type RemoteHostStub = {
    gitProvider: {
      exec: ReturnType<typeof vi.fn>
      checkIgnoredPaths: ReturnType<typeof vi.fn>
    }
    fsProvider: {
      readFile: ReturnType<typeof vi.fn>
      stat: ReturnType<typeof vi.fn>
      lstat: ReturnType<typeof vi.fn>
      createDir: ReturnType<typeof vi.fn>
      copy: ReturnType<typeof vi.fn>
    }
  }

  function createRemoteHostStub(options: {
    includeContent?: string
    tracked?: string[]
    ignored?: string[]
    stats?: Record<string, FileStat['type']>
    copyError?: Error
  }): RemoteHostStub {
    // Why: the remote ops prefer lstat (to reject symlinked sources); it and
    // stat share the same fixture map so a 'symlink' type can be expressed.
    const statImpl = (filePath: string): Promise<FileStat> => {
      const name = filePath.split('/').at(-1) ?? ''
      const type = options.stats?.[name]
      if (!type) {
        return Promise.reject(new Error('ENOENT'))
      }
      return Promise.resolve({ size: 1, type, mtime: 0 } satisfies FileStat)
    }
    return {
      gitProvider: {
        exec: vi.fn().mockResolvedValue({
          stdout: (options.tracked ?? []).join('\0'),
          stderr: ''
        }),
        checkIgnoredPaths: vi.fn().mockResolvedValue(options.ignored ?? [])
      },
      fsProvider: {
        readFile: vi.fn().mockImplementation(() => {
          if (options.includeContent === undefined) {
            return Promise.reject(new Error('ENOENT: no such file'))
          }
          return Promise.resolve({ content: options.includeContent, isBinary: false })
        }),
        stat: vi.fn().mockImplementation(statImpl),
        lstat: vi.fn().mockImplementation(statImpl),
        createDir: vi.fn().mockResolvedValue(undefined),
        copy: vi.fn().mockImplementation(() => {
          if (options.copyError) {
            return Promise.reject(options.copyError)
          }
          return Promise.resolve()
        })
      }
    }
  }

  function runRemoteCopy(stub: RemoteHostStub) {
    return copyRemoteWorktreeIncludeFiles(
      '/remote/repo',
      '/remote/worktree',
      stub.gitProvider as never,
      stub.fsProvider as never
    )
  }

  it('returns undefined when the remote include file is unreadable or absent', async () => {
    const stub = createRemoteHostStub({})
    await expect(runRemoteCopy(stub)).resolves.toBeUndefined()
    expect(stub.gitProvider.exec).not.toHaveBeenCalled()
  })

  it('copies ignored files on the remote host, creating parent directories', async () => {
    const stub = createRemoteHostStub({
      includeContent: '.claude/settings.local.json\ntracked.txt\n',
      tracked: ['tracked.txt'],
      ignored: ['.claude/settings.local.json'],
      stats: { 'settings.local.json': 'file' }
    })

    await expect(runRemoteCopy(stub)).resolves.toEqual({
      copied: ['.claude/settings.local.json'],
      skipped: [{ path: 'tracked.txt', reason: 'tracked' }]
    })
    expect(stub.gitProvider.exec).toHaveBeenCalledWith(
      ['ls-files', '-z', '--', '.claude/settings.local.json', 'tracked.txt'],
      '/remote/repo'
    )
    expect(stub.fsProvider.createDir).toHaveBeenCalledWith('/remote/worktree/.claude')
    expect(stub.fsProvider.copy).toHaveBeenCalledWith(
      '/remote/repo/.claude/settings.local.json',
      '/remote/worktree/.claude/settings.local.json'
    )
  })

  it('maps the relay no-clobber EEXIST error to destination-exists', async () => {
    const stub = createRemoteHostStub({
      includeContent: '.env.local\n',
      ignored: ['.env.local'],
      stats: { '.env.local': 'file' },
      copyError: new Error('EEXIST: destination already exists')
    })

    await expect(runRemoteCopy(stub)).resolves.toEqual({
      copied: [],
      skipped: [{ path: '.env.local', reason: 'destination-exists' }]
    })
  })

  it('skips all entries when the remote git checks fail', async () => {
    const stub = createRemoteHostStub({
      includeContent: '.env.local\n',
      stats: { '.env.local': 'file' }
    })
    stub.gitProvider.exec.mockRejectedValue(new Error('relay disconnected'))

    await expect(runRemoteCopy(stub)).resolves.toEqual({
      copied: [],
      skipped: [{ path: '.env.local', reason: 'check-failed' }]
    })
    expect(stub.fsProvider.copy).not.toHaveBeenCalled()
  })

  it('skips an ignored entry that is missing on the remote host', async () => {
    const stub = createRemoteHostStub({
      includeContent: '.env.local\n',
      ignored: ['.env.local']
      // no stats entry -> lstat rejects -> 'missing'
    })

    await expect(runRemoteCopy(stub)).resolves.toEqual({
      copied: [],
      skipped: [{ path: '.env.local', reason: 'missing' }]
    })
    expect(stub.fsProvider.copy).not.toHaveBeenCalled()
  })

  it('refuses a symlinked remote source via lstat instead of copying it', async () => {
    const stub = createRemoteHostStub({
      includeContent: '.env.local\n',
      ignored: ['.env.local'],
      stats: { '.env.local': 'symlink' }
    })

    await expect(runRemoteCopy(stub)).resolves.toEqual({
      copied: [],
      skipped: [{ path: '.env.local', reason: 'not-a-file' }]
    })
    expect(stub.fsProvider.lstat).toHaveBeenCalledWith('/remote/repo/.env.local')
    expect(stub.fsProvider.copy).not.toHaveBeenCalled()
  })
})
