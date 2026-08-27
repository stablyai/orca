import { beforeEach, describe, expect, it, vi } from 'vitest'
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

/**
 * A tiny in-memory filesystem, because every assertion here is about what the
 * cache does when one specific path's mtime or bytes move. Sequenced
 * `mockResolvedValueOnce` stacks cannot express that: the stamp and the diff
 * read touch overlapping paths in an order the test should not have to know.
 */
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

// Old enough that a further write is guaranteed to move the mtime, which is what
// lets the cache store at all.
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
  // No `.git` file entry: `.git` is a directory, so reading it as a pointer misses.
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
    // `.gitmodules` is absent, so submodule routing resolves to "no submodules".
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

  // The four invalidation axes, one per diff input. Each proves the stale result is
  // never served, which matters more than any of the hits above.
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

  // The dangerous ordering: the read observed pre-mutation state, so storing its
  // result after the mutation would pin a diff that was already wrong.
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

  // The stamp is itself several awaited stats, so a mutation can begin and end entirely
  // inside it — leaving a stamp torn across the mutation that no later stamp can match.
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

  // A write inside the mtime granularity window could be overwritten again without
  // moving the timestamp, so that read is not allowed to become a cache entry.
  it('refuses to store a diff of a file written moments ago', async () => {
    writeFile(WORKING_TREE_PATH, 'just-saved', Date.now())

    await getDiff(REPO, FILE, false)
    const spawnsAfterFirst = blobReadCount()
    await getDiff(REPO, FILE, false)

    expect(blobReadCount()).toBeGreaterThan(spawnsAfterFirst)
    expect(settledDiffCache.stats().racyWrites).toBeGreaterThan(0)
    expect(settledDiffCache.stats().entries).toBe(0)
  })

  // A folder workspace, or any path that is not a git checkout, cannot be stamped.
  it('never caches when the repo layout cannot be stamped', async () => {
    files.delete(HEAD_PATH)

    await getDiff(REPO, FILE, false)
    const spawnsAfterFirst = blobReadCount()
    await getDiff(REPO, FILE, false)

    expect(blobReadCount()).toBeGreaterThan(spawnsAfterFirst)
    expect(settledDiffCache.stats().unprovable).toBeGreaterThan(0)
    expect(settledDiffCache.stats().entries).toBe(0)
  })

  // A WSL relay that never reached git returns the same empty left side as a new
  // file does, so persisting it would pin a wrong diff until something else moved.
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
    gitExecFileAsyncBufferMock.mockRejectedValue(
      Object.assign(new Error("fatal: path 'src/file.ts' does not exist"), { code: 128 })
    )

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

  // A staged diff compares HEAD to the index, so a working-tree edit must not evict it.
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

    // Why exactly equal: the second read must join the first, not start its own spawns.
    expect(blobReadCount()).toBe(spawnsBeforePoll)
  })
})
