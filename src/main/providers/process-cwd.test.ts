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
        ['-a', '-p', '42', '-d', 'cwd', '-Fn'],
        { encoding: 'utf-8', timeout: 1500 },
        expect.any(Function)
      )
    )
    await vi.advanceTimersByTimeAsync(1500)

    expect(settled).toBe(true)
    await expect(cwdPromise).resolves.toBe('')
    expect(killMock).toHaveBeenCalled()
  })
})
