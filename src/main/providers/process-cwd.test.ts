import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, readlinkMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  readlinkMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

vi.mock('fs/promises', () => ({
  readlink: readlinkMock
}))

describe('resolveProcessCwd', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    execFileMock.mockReset()
    readlinkMock.mockReset()
    vi.spyOn(Date, 'now').mockReturnValue(10_000)
    readlinkMock.mockImplementation(async (procPath: string) => {
      const pid = procPath.match(/\/proc\/(\d+)\/cwd$/)?.[1] ?? 'unknown'
      return `/cwd/${pid}`
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bounds cached cwd results across unique process ids', async () => {
    const { resolveProcessCwd } = await import('./process-cwd')

    for (let pid = 1; pid <= 257; pid += 1) {
      await expect(resolveProcessCwd(pid)).resolves.toBe(`/cwd/${pid}`)
    }

    expect(readlinkMock).toHaveBeenCalledTimes(257)

    await expect(resolveProcessCwd(257)).resolves.toBe('/cwd/257')
    expect(readlinkMock).toHaveBeenCalledTimes(257)

    await expect(resolveProcessCwd(1)).resolves.toBe('/cwd/1')
    expect(readlinkMock).toHaveBeenCalledTimes(258)
  })

  it('falls back when lsof never reports completion', async () => {
    vi.useFakeTimers()
    readlinkMock.mockRejectedValue(new Error('proc unavailable'))
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }))
    const { resolveProcessCwd } = await import('./process-cwd')

    let settled = false
    const cwdPromise = resolveProcessCwd(42).then((cwd) => {
      settled = true
      return cwd
    })

    await vi.waitFor(() =>
      expect(execFileMock).toHaveBeenCalledWith(
        'lsof',
        ['-b', '-w', '-a', '-p', '42', '-d', 'cwd', '-Fn'],
        { encoding: 'utf-8', timeout: 1500 },
        expect.any(Function)
      )
    )
    await vi.advanceTimersByTimeAsync(1500)

    expect(settled).toBe(true)
    await expect(cwdPromise).resolves.toBe('')
    expect(killMock).toHaveBeenCalled()
  })

  it('answers from lsof -b while in-process cwd lookups hang on a wedged mount, holding at most two pool threads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    readlinkMock.mockRejectedValue(new Error('proc unavailable'))
    execFileMock.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (...result: unknown[]) => void
      ) => {
        callback(null, `p${args[4]}\nfcwd\nn/Volumes/dead/${args[4]}\n`)
        return { kill: vi.fn() }
      }
    )
    const { setLibprocAddonForTests } = await import('../../shared/libproc-addon')
    const readProcessCwd = vi.fn(() => new Promise<never>(() => {}))
    setLibprocAddonForTests({
      readProcessTable: async () => [],
      readProcessCwd,
      readProcessPath: async () => null
    })
    const { resolveProcessCwd } = await import('./process-cwd')

    const cwds = Promise.all([1, 2, 3].map((pid) => resolveProcessCwd(pid)))
    await vi.advanceTimersByTimeAsync(250)

    await expect(cwds).resolves.toEqual(['/Volumes/dead/1', '/Volumes/dead/2', '/Volumes/dead/3'])
    expect(readProcessCwd).toHaveBeenCalledTimes(2)
    setLibprocAddonForTests(undefined)
  })

  it('keeps one stuck lsof per pid instead of spawning another every poll', async () => {
    // The result cache must expire between polls.
    vi.restoreAllMocks()
    vi.useFakeTimers()
    readlinkMock.mockRejectedValue(new Error('proc unavailable'))
    // SIGTERM cannot interrupt lsof waiting in the kernel on a dead mount, so it never exits.
    execFileMock.mockImplementation(() => ({ kill: vi.fn() }))
    const { resolveProcessCwd } = await import('./process-cwd')

    for (let poll = 0; poll < 3; poll += 1) {
      const cwd = resolveProcessCwd(42)
      await vi.advanceTimersByTimeAsync(1500)
      await expect(cwd).resolves.toBe('')
      // Past the result cache, so the next poll looks the pid up again.
      await vi.advanceTimersByTimeAsync(1500)
    }
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})
