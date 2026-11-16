import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, opendirMock, statMock, openMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  opendirMock: vi.fn(),
  statMock: vi.fn(),
  openMock: vi.fn()
}))

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('node:fs/promises', () => ({ opendir: opendirMock, stat: statMock, open: openMock }))
import {
  maintainRepoPackIndex,
  clearRepoPackIndexMaintenanceCache,
  PACK_INDEX_THRESHOLD
} from './repo-pack-index-maintenance'

import { PACK_INDEX_PROBE_ENTRY_LIMIT } from './repo-pack-index-state'

function directory(packs: number) {
  return {
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < packs; index += 1) {
        yield { name: `pack-${index}.idx`, isFile: () => true, isSymbolicLink: () => false }
        yield { name: `pack-${index}.pack`, isFile: () => true, isSymbolicLink: () => false }
      }
    }
  }
}

function args(wslDistro?: string) {
  const attributes: Record<string, unknown> = {}
  return {
    repoPath: wslDistro ? '//wsl$/Ubuntu/repo' : '/repo',
    commonDir: wslDistro ? String.raw`\\wsl.localhost\Ubuntu\repo\.git` : '/repo/.git',
    ...(wslDistro ? { wslDistro } : {}),
    signal: new AbortController().signal,
    canWrite: () => true,
    span: {
      setAttribute: (key: string, value: unknown) => {
        attributes[key] = value
      }
    },
    attributes
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  clearRepoPackIndexMaintenanceCache()
  gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
    if (argv[0] === 'config') {
      throw Object.assign(new Error('unset'), { code: 1 })
    }
    return { stdout: '', stderr: '' }
  })
  opendirMock.mockResolvedValue(directory(PACK_INDEX_THRESHOLD))
  statMock.mockResolvedValue({ dev: 1n, ino: 2n, mtimeNs: 3n, ctimeNs: 4n })
  openMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
})

describe('idle pack index maintenance', () => {
  it('caps a directory stream and skips writes when bitmap absence cannot be proved', async () => {
    let produced = 0
    let closed = false
    opendirMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        try {
          while (produced < 100_000) {
            produced += 1
            yield { name: `pack-${produced}.pack`, isFile: () => true, isSymbolicLink: () => false }
          }
        } finally {
          closed = true
        }
      }
    })
    const options = args()
    await maintainRepoPackIndex(options)
    expect(produced).toBe(PACK_INDEX_PROBE_ENTRY_LIMIT)
    expect(closed).toBe(true)
    expect(options.attributes['git.pack_index_outcome']).toBe('protected')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed on config errors other than an unset key', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('invalid config'), { code: 128 })
    )
    const options = args()
    await maintainRepoPackIndex(options)
    expect(opendirMock).not.toHaveBeenCalled()
    expect(options.attributes['git.pack_index_outcome']).toBe('failed')
  })

  it('protects metadata discovered after the pack threshold during the final probe', async () => {
    opendirMock.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield* directory(PACK_INDEX_THRESHOLD)
        yield { name: 'multi-pack-index-old.bitmap', isFile: () => true }
      }
    })
    const options = args()
    await expect(maintainRepoPackIndex(options)).resolves.toBe('protected')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('does not start the writer when the final probe is cancelled', async () => {
    const controller = new AbortController()
    opendirMock.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield* directory(PACK_INDEX_THRESHOLD)
        controller.abort()
      }
    })
    const options = { ...args(), signal: controller.signal }
    await expect(maintainRepoPackIndex(options)).resolves.toBe('deferred')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(options.attributes['git.pack_index_pack_count_floor']).toBe(PACK_INDEX_THRESHOLD)
  })
})
