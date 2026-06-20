import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, spawnSyncMock, existsSyncMock, readFileSyncMock, rmSyncMock, appMock } =
  vi.hoisted(() => ({
    spawnMock: vi.fn(),
    spawnSyncMock: vi.fn(),
    existsSyncMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    rmSyncMock: vi.fn(),
    appMock: {
      disableHardwareAcceleration: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
      once: vi.fn()
    }
  }))

vi.mock('child_process', () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock
}))
vi.mock('electron', () => ({ app: appMock }))

const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_DISPLAY = process.env.DISPLAY

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('ensureVirtualDisplayForHeadlessServe', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnSyncMock.mockReset()
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    appMock.disableHardwareAcceleration.mockReset()
    appMock.commandLine.appendSwitch.mockReset()
    appMock.once.mockReset()
    delete process.env.DISPLAY
  })

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM)
    if (ORIGINAL_DISPLAY === undefined) {
      delete process.env.DISPLAY
    } else {
      process.env.DISPLAY = ORIGINAL_DISPLAY
    }
  })

  it('is a no-op (supported) on non-Linux platforms', async () => {
    setPlatform('darwin')
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('does not start a display outside serve mode on Linux', async () => {
    setPlatform('linux')
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    // Desktop Linux (non-serve) is reported unsupported for the offscreen path
    // here, and never spawns Xvfb.
    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: false })).toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('reuses an externally provided DISPLAY without starting Xvfb', async () => {
    setPlatform('linux')
    process.env.DISPLAY = ':0'
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.env.DISPLAY).toBe(':0')
  })

  it('reports unsupported (no spawn) when Xvfb is not installed', async () => {
    setPlatform('linux')
    spawnSyncMock.mockReturnValue({ status: 1 }) // `which Xvfb` fails
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('starts Xvfb and switches to software rendering when none exists', async () => {
    setPlatform('linux')
    spawnSyncMock.mockReturnValue({ status: 0 }) // `which Xvfb` succeeds
    // First existsSync (stale-socket check) false; later (socket-ready poll) true.
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true)
    spawnMock.mockReturnValue({ once: vi.fn(), kill: vi.fn(), killed: false })
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    expect(spawnMock).toHaveBeenCalledWith(
      'Xvfb',
      expect.arrayContaining([':99']),
      expect.anything()
    )
    expect(process.env.DISPLAY).toBe(':99')
    expect(appMock.disableHardwareAcceleration).toHaveBeenCalled()
    expect(appMock.commandLine.appendSwitch).toHaveBeenCalledWith('disable-gpu')
  })

  it('reuses an existing virtual display only when its X server is alive', async () => {
    setPlatform('linux')
    spawnSyncMock.mockReturnValue({ status: 0 })
    existsSyncMock.mockReturnValue(true) // :99 socket + lock present
    readFileSyncMock.mockReturnValue('4321\n') // lock holds a PID
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never) // PID alive
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    expect(killSpy).toHaveBeenCalledWith(4321, 0)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(rmSyncMock).not.toHaveBeenCalled()
    expect(process.env.DISPLAY).toBe(':99')
    killSpy.mockRestore()
  })

  it('treats a stale socket (dead server) as no display and starts a fresh Xvfb', async () => {
    setPlatform('linux')
    spawnSyncMock.mockReturnValue({ status: 0 })
    existsSyncMock.mockReturnValue(true) // orphan socket + lock present
    readFileSyncMock.mockReturnValue('9999\n')
    // PID is gone: process.kill throws ESRCH.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    spawnMock.mockReturnValue({ once: vi.fn(), kill: vi.fn(), killed: false })
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    // Stale artifacts cleaned, then a fresh server started.
    expect(rmSyncMock).toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledWith(
      'Xvfb',
      expect.arrayContaining([':99']),
      expect.anything()
    )
    expect(process.env.DISPLAY).toBe(':99')
    killSpy.mockRestore()
  })
})
