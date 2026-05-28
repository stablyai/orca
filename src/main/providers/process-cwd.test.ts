import { beforeEach, describe, expect, it, vi } from 'vitest'

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
})
