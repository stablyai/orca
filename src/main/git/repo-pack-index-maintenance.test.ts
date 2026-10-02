import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, opendirMock, statMock, openMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  opendirMock: vi.fn(),
  statMock: vi.fn(),
  openMock: vi.fn()
}))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('node:fs/promises', () => ({ opendir: opendirMock, stat: statMock, open: openMock }))

import {
  maintainRepoPackIndex,
  clearRepoPackIndexMaintenanceCache,
  PACK_INDEX_FORCE_REFRESH_MS,
  PACK_INDEX_THRESHOLD,
  PACK_INDEX_TIMEOUT_MS
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
  it('leaves a healthy repository alone', async () => {
    const options = args()
    opendirMock.mockResolvedValue(directory(PACK_INDEX_THRESHOLD - 1))
    await maintainRepoPackIndex(options)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(options.attributes['git.pack_index_outcome']).toBe('below_threshold')
  })

  it('writes only the lookup index with background admission and a deadline', async () => {
    const options = args()
    await maintainRepoPackIndex(options)
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(['multi-pack-index', 'write'], {
      cwd: '/repo',
      admissionTier: 'background',
      timeout: PACK_INDEX_TIMEOUT_MS
    })
    expect(options.attributes['git.pack_index_outcome']).toBe('written')
  })

  it('rechecks idle admission after probing and never aborts an admitted writer', async () => {
    const options = args()
    await maintainRepoPackIndex({ ...options, canWrite: () => false })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(opendirMock).not.toHaveBeenCalled()
    expect(options.attributes['git.pack_index_outcome']).toBe('deferred')
    let idle = true
    opendirMock.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield* directory(PACK_INDEX_THRESHOLD)
        idle = false
      }
    })
    await expect(maintainRepoPackIndex({ ...args(), canWrite: () => idle })).resolves.toBe(
      'deferred'
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    await maintainRepoPackIndex(args())
    expect(gitExecFileAsyncMock.mock.lastCall?.[1]).not.toHaveProperty('signal')
  })

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

  it('inspects the measured 11,424-pack repository with four directory entries per pack', async () => {
    let produced = 0
    opendirMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 11_424; index += 1) {
          for (const suffix of ['pack', 'idx', 'rev', 'keep']) {
            produced += 1
            yield {
              name: `pack-${index}.${suffix}`,
              isFile: () => true,
              isSymbolicLink: () => false
            }
          }
        }
      }
    })
    await expect(maintainRepoPackIndex(args())).resolves.toBe('written')
    expect(produced).toBe(11_424 * 4)
    expect(opendirMock).toHaveBeenCalledOnce()
  })

  it('honours an explicit multi-pack-index opt-out before walking objects', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'false\n', stderr: '' })
    await maintainRepoPackIndex(args())
    expect(opendirMock).not.toHaveBeenCalled()
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

  it('does not infer consent from an unreadable boolean or a missing Git binary', async () => {
    for (const config of [
      () => Promise.resolve({ stdout: 'unexpected', stderr: '' }),
      () => Promise.reject(Object.assign(new Error('missing Git'), { code: 'ENOENT' }))
    ]) {
      gitExecFileAsyncMock.mockImplementationOnce(config)
      const options = args()
      await maintainRepoPackIndex(options)
      expect(options.attributes['git.pack_index_outcome']).toBe('failed')
    }
    expect(opendirMock).not.toHaveBeenCalled()
  })

  it('records index failures without preventing later ref maintenance', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(Object.assign(new Error('unset'), { code: 1 }))
      .mockRejectedValueOnce(new Error('index locked'))
    const options = args()
    await expect(maintainRepoPackIndex(options)).resolves.toBe('failed')
    expect(options.attributes['git.pack_index_outcome']).toBe('failed')
  })

  it('skips repositories without pack files and cancelled attempts', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const options = args()
    await maintainRepoPackIndex(options)
    expect(options.attributes['git.pack_index_outcome']).toBe('below_threshold')
    const abort = new AbortController()
    abort.abort()
    gitExecFileAsyncMock.mockClear()
    await maintainRepoPackIndex({ ...args(), signal: abort.signal })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('walks the WSL share and runs Git on that execution host', async () => {
    const options = args('Ubuntu')
    await maintainRepoPackIndex(options)
    expect(opendirMock).toHaveBeenCalledWith(
      String.raw`\\wsl.localhost\Ubuntu\repo\.git\objects\pack`
    )
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['multi-pack-index', 'write'],
      expect.objectContaining({ cwd: '//wsl$/Ubuntu/repo', wslDistro: 'Ubuntu' })
    )
  })

  it('skips unchanged directory stamps but refreshes changed packs and periodically rechecks', async () => {
    const options = args()
    await maintainRepoPackIndex(options)
    await expect(maintainRepoPackIndex(options)).resolves.toBe('unchanged')
    expect(opendirMock).toHaveBeenCalledOnce()
    statMock.mockResolvedValue({ dev: 1n, ino: 2n, mtimeNs: 5n, ctimeNs: 6n })
    await expect(maintainRepoPackIndex(options)).resolves.toBe('written')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + PACK_INDEX_FORCE_REFRESH_MS + 1)
    await expect(maintainRepoPackIndex(options)).resolves.toBe('written')
    vi.restoreAllMocks()
  })

  it('isolates directory stamps by the execution host', async () => {
    const options = args()
    await maintainRepoPackIndex(options)
    await expect(maintainRepoPackIndex({ ...options, wslDistro: 'Ubuntu' })).resolves.toBe(
      'written'
    )
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
