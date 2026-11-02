import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'
import { createBoundedFileReaderModuleMock, createGitRunnerModuleMock } from './status-test-harness'

const {
  gitExecFileAsyncMock,
  gitExecFileAsyncBufferMock,
  gitStreamOptionsMock,
  lstatMock,
  realpathMock,
  rmMock,
  existsSyncMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncBufferMock: vi.fn(),
  gitStreamOptionsMock: vi.fn(),
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  rmMock: vi.fn(),
  existsSyncMock: vi.fn()
}))

// Key mocks by path: stamp and blob reads overlap without a fixed ordering.
type FakeFile = { content: Buffer; mtimeMs: number; ino: number }

const { files } = vi.hoisted(() => ({ files: new Map<string, FakeFile>() }))

const { readFileMock, statMock, accessMock } = vi.hoisted(() => {
  const missing = (target: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
  return {
    readFileMock: vi.fn(async (target: string, encoding?: BufferEncoding) => {
      const file = files.get(target)
      if (!file) {
        throw missing(target)
      }
      return encoding ? file.content.toString(encoding) : file.content
    }),
    statMock: vi.fn(async (target: string) => {
      const file = files.get(target)
      if (!file) {
        throw missing(target)
      }
      return {
        isFile: () => true,
        size: file.content.byteLength,
        mtimeMs: file.mtimeMs,
        ino: file.ino
      }
    }),
    accessMock: vi.fn(async (target: string) => {
      if (!files.has(target)) {
        throw missing(target)
      }
    })
  }
})

vi.mock('./runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

vi.mock('fs/promises', () => ({
  lstat: lstatMock,
  realpath: realpathMock,
  readFile: readFileMock,
  stat: statMock,
  rm: rmMock,
  access: accessMock
}))

vi.mock('fs', () => ({ existsSync: existsSyncMock }))

vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)

import { getDiff, getStatus, invalidateGitReadCaches, stageFile } from './status'
import { settledDiffCache } from './source-control/git-read-cache-invalidation'

const REPO = '/repo'
const FILE = 'src/file.ts'
const WORKING_TREE_PATH = `${REPO}/${FILE}`
const HEAD_PATH = `${REPO}/.git/HEAD`
const REF_PATH = `${REPO}/.git/refs/heads/main`
const INDEX_PATH = `${REPO}/.git/index`
const GITMODULES_PATH = `${REPO}/.gitmodules`

// Old enough to satisfy the racy-write margin.
const SETTLED_MTIME_MS = Date.now() - 60_000
let nextInode = 100

function writeFile(target: string, content: string, mtimeMs = SETTLED_MTIME_MS): void {
  files.set(target, { content: Buffer.from(content), mtimeMs, ino: (nextInode += 1) })
}

function blobReadCount(): number {
  return gitExecFileAsyncBufferMock.mock.calls.length
}

function seedRepo(): void {
  files.clear()
  writeFile(HEAD_PATH, 'ref: refs/heads/main\n')
  writeFile(REF_PATH, `${'a'.repeat(40)}\n`)
  writeFile(INDEX_PATH, 'index-bytes')
  writeFile(WORKING_TREE_PATH, 'working-tree-content')
}

describe('settled diff cache', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    gitStreamOptionsMock.mockReset()
    readFileMock.mockClear()
    statMock.mockClear()
    accessMock.mockClear()
    existsSyncMock.mockReset()
    invalidateGitReadCaches()
    settledDiffCache.resetStatsForTests()
    seedRepo()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    gitExecFileAsyncBufferMock.mockResolvedValue({ stdout: Buffer.from('index-content\n') })
  })

  it('serves the second read of an unchanged file without respawning git', async () => {
    const first = await getDiff(REPO, FILE, false)
    const spawnsAfterFirst = blobReadCount()

    const second = await getDiff(REPO, FILE, false)

    expect(spawnsAfterFirst).toBeGreaterThan(0)
    expect(blobReadCount()).toBe(spawnsAfterFirst)
    expect(second).toEqual(first)
    expect(settledDiffCache.stats().hits).toBe(1)
  })

  describe('on a Windows host reading a raw Linux WSL worktree path', () => {
    const WSL_WORKTREE = '/home/me/repo/feature'
    const WSL_OPTIONS = { wslDistro: 'Ubuntu' }
    const HOST_WORKTREE = String.raw`\\wsl.localhost\Ubuntu\home\me\repo\feature`
    let platformDescriptor: PropertyDescriptor | undefined

    beforeEach(() => {
      platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      files.clear()
      writeFile(path.join(HOST_WORKTREE, '.git/HEAD'), 'ref: refs/heads/main\n')
      writeFile(path.join(HOST_WORKTREE, '.git/refs/heads/main'), `${'a'.repeat(40)}\n`)
      writeFile(path.join(HOST_WORKTREE, '.git/index'), 'index-bytes')
      writeFile(path.join(HOST_WORKTREE, FILE), 'working-tree-content')
    })

    afterEach(() => {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
    })

    it('reads the working tree through the host spelling instead of reporting a deletion', async () => {
      const result = await getDiff(WSL_WORKTREE, FILE, false, false, WSL_OPTIONS)

      expect(result.modifiedContent).toBe('working-tree-content')
      expect(readFileMock).toHaveBeenCalledWith(path.join(HOST_WORKTREE, FILE))
      expect(readFileMock).not.toHaveBeenCalledWith(path.join(WSL_WORKTREE, FILE))
    })

    it('stamps through the host spelling so the second read does not respawn git', async () => {
      await getDiff(WSL_WORKTREE, FILE, false, false, WSL_OPTIONS)
      const spawnsAfterFirst = blobReadCount()

      await getDiff(WSL_WORKTREE, FILE, false, false, WSL_OPTIONS)

      expect(spawnsAfterFirst).toBeGreaterThan(0)
      expect(blobReadCount()).toBe(spawnsAfterFirst)
      expect(settledDiffCache.stats().hits).toBe(1)
      expect(statMock).toHaveBeenCalledWith(path.join(HOST_WORKTREE, '.git/index'))
    })

    // A permanently absent component would stop the stamp moving and serve stale diffs.
    it('invalidates when the working tree file is edited under the host spelling', async () => {
      await getDiff(WSL_WORKTREE, FILE, false, false, WSL_OPTIONS)
      const spawnsAfterFirst = blobReadCount()

      writeFile(path.join(HOST_WORKTREE, FILE), 'edited-in-another-editor')
      const second = await getDiff(WSL_WORKTREE, FILE, false, false, WSL_OPTIONS)

      expect(blobReadCount()).toBeGreaterThan(spawnsAfterFirst)
      expect(second.modifiedContent).toBe('edited-in-another-editor')
    })

    it('invalidates when .gitmodules appears under the host spelling', async () => {
      await getDiff(WSL_WORKTREE, FILE, false, false, WSL_OPTIONS)
      const spawnsAfterFirst = blobReadCount()

      writeFile(path.join(HOST_WORKTREE, '.gitmodules'), '[submodule "vendor"]\n')
      await getDiff(WSL_WORKTREE, FILE, false, false, WSL_OPTIONS)

      expect(blobReadCount()).toBeGreaterThan(spawnsAfterFirst)
      expect(statMock).toHaveBeenCalledWith(path.join(HOST_WORKTREE, '.gitmodules'))
    })
  })

  // Empty worktrees must not turn filesystem reads into paths relative to Orca's own checkout.
  it('reads nothing relative to the cwd when the worktree path has no host spelling', async () => {
    await getDiff('', FILE, false)

    expect(statMock).not.toHaveBeenCalledWith(FILE)
    expect(readFileMock).not.toHaveBeenCalledWith('.git', 'utf-8')
    expect(settledDiffCache.stats().entries).toBe(0)
  })

  it.each([
    [
      'the working tree file is edited',
      () => writeFile(WORKING_TREE_PATH, 'edited-in-another-editor')
    ],
    ['the index is rewritten by git add', () => writeFile(INDEX_PATH, 'index-bytes-after-add')],
    ['HEAD moves to a new commit', () => writeFile(REF_PATH, `${'b'.repeat(40)}\n`)],
    ['HEAD is detached onto another commit', () => writeFile(HEAD_PATH, `${'c'.repeat(40)}\n`)],
    ['.gitmodules appears', () => writeFile(GITMODULES_PATH, '[submodule "vendor"]\n')]
  ])('re-reads after %s', async (_name, mutate) => {
    await getDiff(REPO, FILE, false)
    const spawnsAfterFirst = blobReadCount()

    mutate()
    gitExecFileAsyncBufferMock.mockResolvedValue({ stdout: Buffer.from('fresh-index-content\n') })
    const second = await getDiff(REPO, FILE, false)

    expect(blobReadCount()).toBeGreaterThan(spawnsAfterFirst)
    expect(second).toMatchObject({ originalContent: 'fresh-index-content\n' })
  })

  it('re-reads after a mutation runs through the shared invalidation point', async () => {
    await getDiff(REPO, FILE, false)
    const spawnsAfterFirst = blobReadCount()

    await stageFile(REPO, FILE)
    await getDiff(REPO, FILE, false)

    expect(blobReadCount()).toBeGreaterThan(spawnsAfterFirst)
  })

  it('refuses to store a result for a read that a mutation overtook', async () => {
    let releaseBlob = (): void => {}
    const blocked = new Promise<{ stdout: Buffer }>((resolve) => {
      releaseBlob = () => resolve({ stdout: Buffer.from('pre-mutation\n') })
    })
    gitExecFileAsyncBufferMock.mockReturnValue(blocked)

    const inFlight = getDiff(REPO, FILE, false)
    await vi.waitFor(() => expect(blobReadCount()).toBeGreaterThan(0))
    invalidateGitReadCaches()
    releaseBlob()
    await inFlight

    expect(settledDiffCache.stats().invalidatedDuringRead).toBe(1)
    expect(settledDiffCache.stats().entries).toBe(0)

    const spawnsAfterFirst = blobReadCount()
    gitExecFileAsyncBufferMock.mockResolvedValue({ stdout: Buffer.from('post-mutation\n') })
    const second = await getDiff(REPO, FILE, false)

    expect(blobReadCount()).toBeGreaterThan(spawnsAfterFirst)
    expect(second).toMatchObject({ originalContent: 'post-mutation\n' })
  })

  // Mutations may begin and end during the awaited stamp reads.
  it('refuses to store a result for a mutation that landed inside the stamp read', async () => {
    const baseStat = statMock.getMockImplementation()
    if (!baseStat) {
      throw new Error('the fake filesystem lost its stat implementation')
    }
    let invalidated = false
    statMock.mockImplementation(async (target: string) => {
      if (!invalidated && target === INDEX_PATH) {
        invalidated = true
        invalidateGitReadCaches()
      }
      return baseStat(target)
    })
    try {
      await getDiff(REPO, FILE, false)
    } finally {
      statMock.mockImplementation(baseStat)
    }

    expect(invalidated).toBe(true)
    expect(settledDiffCache.stats().invalidatedDuringRead).toBe(1)
    expect(settledDiffCache.stats().entries).toBe(0)
  })

  it('refuses to store a diff of a file written moments ago', async () => {
    writeFile(WORKING_TREE_PATH, 'just-saved', Date.now())

    await getDiff(REPO, FILE, false)
    const spawnsAfterFirst = blobReadCount()
    await getDiff(REPO, FILE, false)

    expect(blobReadCount()).toBeGreaterThan(spawnsAfterFirst)
    expect(settledDiffCache.stats().racyWrites).toBeGreaterThan(0)
    expect(settledDiffCache.stats().entries).toBe(0)
  })

  it('never caches when the repo layout cannot be stamped', async () => {
    files.delete(HEAD_PATH)

    await getDiff(REPO, FILE, false)
    const spawnsAfterFirst = blobReadCount()
    await getDiff(REPO, FILE, false)

    expect(blobReadCount()).toBeGreaterThan(spawnsAfterFirst)
    expect(settledDiffCache.stats().unprovable).toBeGreaterThan(0)
    expect(settledDiffCache.stats().entries).toBe(0)
  })

  it('refuses to store a diff whose blob read failed rather than proved absence', async () => {
    gitExecFileAsyncBufferMock.mockRejectedValue(
      Object.assign(new Error('wsl.exe failed'), { code: 1 })
    )

    await getDiff(REPO, FILE, false)
    const spawnsAfterFirst = blobReadCount()
    await getDiff(REPO, FILE, false)

    expect(blobReadCount()).toBeGreaterThan(spawnsAfterFirst)
    expect(settledDiffCache.stats().entries).toBe(0)
  })

  it('caches a new file whose absence from the index git actually reported', async () => {
    gitExecFileAsyncBufferMock.mockImplementation(async (args: string[]) => {
      const stderr = args.some((arg) => arg.startsWith(':'))
        ? "fatal: path 'src/file.ts' exists on disk, but not in the index"
        : "fatal: path 'src/file.ts' exists on disk, but not in 'HEAD'"
      throw Object.assign(new Error(stderr), { code: 128, stderr: Buffer.from(stderr) })
    })

    await getDiff(REPO, FILE, false)
    const spawnsAfterFirst = blobReadCount()
    await getDiff(REPO, FILE, false)

    expect(blobReadCount()).toBe(spawnsAfterFirst)
    expect(settledDiffCache.stats().hits).toBe(1)
  })

  it('keeps staged and unstaged diffs of one file in separate entries', async () => {
    await getDiff(REPO, FILE, false)
    const spawnsAfterUnstaged = blobReadCount()

    await getDiff(REPO, FILE, true)

    expect(blobReadCount()).toBeGreaterThan(spawnsAfterUnstaged)
  })

  it('keeps a staged diff across a working-tree edit', async () => {
    await getDiff(REPO, FILE, true)
    const spawnsAfterFirst = blobReadCount()

    writeFile(WORKING_TREE_PATH, 'edited-after-staging')
    await getDiff(REPO, FILE, true)

    expect(blobReadCount()).toBe(spawnsAfterFirst)
  })

  it('does not let a status poll drop the in-flight diff read', async () => {
    let releaseBlob = (): void => {}
    const blocked = new Promise<{ stdout: Buffer }>((resolve) => {
      releaseBlob = () => resolve({ stdout: Buffer.from('index-content\n') })
    })
    gitExecFileAsyncBufferMock.mockReturnValue(blocked)

    const first = getDiff(REPO, FILE, false)
    await vi.waitFor(() => expect(blobReadCount()).toBeGreaterThan(0))
    const spawnsBeforePoll = blobReadCount()

    await getStatus(REPO)
    const second = getDiff(REPO, FILE, false)
    releaseBlob()
    await Promise.all([first, second])

    expect(blobReadCount()).toBe(spawnsBeforePoll)
  })
})
