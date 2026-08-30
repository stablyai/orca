import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  spawnMock,
  spawnSyncMock,
  existsSyncMock,
  readFileSyncMock,
  rmSyncMock,
  statSyncMock,
  appMock
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  appMock: {
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn(), getSwitchValue: vi.fn() },
    once: vi.fn()
  }
}))

vi.mock('child_process', () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock,
  statSync: statSyncMock
}))
vi.mock('electron', () => ({ app: appMock }))

const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_DISPLAY = process.env.DISPLAY

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function mockLiveXDisplay(pid = 4321): void {
  statSyncMock.mockReturnValue({ isSocket: () => true })
  existsSyncMock.mockReturnValue(true)
  readFileSyncMock.mockReturnValue(`${pid}\n`)
  vi.spyOn(process, 'kill').mockImplementation(() => true)
}

describe('ensureVirtualDisplayForHeadlessServe', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnSyncMock.mockReset()
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    statSyncMock.mockReset()
    appMock.disableHardwareAcceleration.mockReset()
    appMock.commandLine.appendSwitch.mockReset()
    appMock.commandLine.getSwitchValue.mockReset().mockReturnValue('')
    appMock.once.mockReset()
    delete process.env.DISPLAY
  })

  afterEach(async () => {
    const { stopVirtualDisplay } = await import('./ensure-virtual-display')
    process.removeListener('exit', stopVirtualDisplay)
    stopVirtualDisplay()
    vi.restoreAllMocks()
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
    mockLiveXDisplay()
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.env.DISPLAY).toBe(':0')
    expect(appMock.disableHardwareAcceleration).toHaveBeenCalled()
    expect(appMock.commandLine.appendSwitch).toHaveBeenCalledWith('disable-dev-shm-usage')
    expect(appMock.commandLine.appendSwitch).toHaveBeenCalledWith('disable-gpu')
  })

  it('reports unsupported (no spawn) when Xvfb is not installed', async () => {
    setPlatform('linux')
    spawnSyncMock.mockReturnValue({ status: 1 }) // `which Xvfb` fails
    const { ensureVirtualDisplayForHeadlessServe, MISSING_LINUX_DISPLAY_MESSAGE } =
      await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(MISSING_LINUX_DISPLAY_MESSAGE).toContain('endpoint is unavailable')
    expect(MISSING_LINUX_DISPLAY_MESSAGE).toContain('XDG_RUNTIME_DIR')
    expect(MISSING_LINUX_DISPLAY_MESSAGE).toContain('`xvfb` on Debian/Ubuntu')
    expect(MISSING_LINUX_DISPLAY_MESSAGE).toContain('`xorg-x11-server-Xvfb`')
  })

  it('starts Xvfb when the configured local display is stale', async () => {
    setPlatform('linux')
    process.env.DISPLAY = ':77'
    spawnSyncMock.mockReturnValue({ status: 0 }) // `which Xvfb` succeeds
    // First existsSync (stale-socket check) false; later (socket-ready poll) true.
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true)
    spawnMock.mockReturnValue({ once: vi.fn(), kill: vi.fn(), killed: false })
    const processOnceSpy = vi.spyOn(process, 'once')
    const processRemoveListenerSpy = vi.spyOn(process, 'removeListener')
    const { ensureVirtualDisplayForHeadlessServe, stopVirtualDisplay } =
      await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    expect(spawnMock).toHaveBeenCalledWith(
      'Xvfb',
      expect.arrayContaining([':99', '-terminate']),
      expect.objectContaining({ detached: true })
    )
    expect(process.env.DISPLAY).toBe(':99')
    expect(appMock.disableHardwareAcceleration).toHaveBeenCalled()
    expect(appMock.commandLine.appendSwitch).toHaveBeenCalledWith('disable-dev-shm-usage')
    expect(appMock.commandLine.appendSwitch).toHaveBeenCalledWith('disable-gpu')
    expect(processOnceSpy).toHaveBeenCalledWith('exit', stopVirtualDisplay)
    const readyHandler = appMock.once.mock.calls.find(([event]) => event === 'ready')?.[1]
    expect(readyHandler).toBeTypeOf('function')
    readyHandler()
    expect(processRemoveListenerSpy).toHaveBeenCalledWith('exit', stopVirtualDisplay)
    expect(appMock.once.mock.calls.some(([event]) => event === 'will-quit')).toBe(false)
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
      expect.arrayContaining([':99', '-terminate']),
      expect.objectContaining({ detached: true })
    )
    expect(process.env.DISPLAY).toBe(':99')
    killSpy.mockRestore()
  })

  describe('hasUsableLinuxDisplay', () => {
    it('accepts live local X11 and Wayland sockets', async () => {
      setPlatform('linux')
      mockLiveXDisplay()
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: ':0' })).toBe(true)
      expect(
        hasUsableLinuxDisplay({
          WAYLAND_DISPLAY: 'wayland-0',
          XDG_RUNTIME_DIR: '/run/user/1000'
        })
      ).toBe(true)
      expect(statSyncMock).toHaveBeenCalledWith('/tmp/.X11-unix/X0')
      expect(statSyncMock).toHaveBeenCalledWith('/run/user/1000/wayland-0')
    })

    it('rejects an orphaned local X11 socket without a live server lock', async () => {
      setPlatform('linux')
      statSyncMock.mockReturnValue({ isSocket: () => true })
      existsSyncMock.mockReturnValue(false)
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: ':77' })).toBe(false)
      expect(existsSyncMock).toHaveBeenCalledWith('/tmp/.X77-lock')
    })

    it('accepts a live local X11 server owned by another user', async () => {
      setPlatform('linux')
      statSyncMock.mockReturnValue({ isSocket: () => true })
      existsSyncMock.mockReturnValue(true)
      readFileSyncMock.mockReturnValue('4321\n')
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
      })
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: ':0' })).toBe(true)
    })

    it('rejects absent, blank, and stale local displays', async () => {
      setPlatform('linux')
      statSyncMock.mockImplementation(() => {
        throw new Error('ENOENT')
      })
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({})).toBe(false)
      expect(hasUsableLinuxDisplay({ DISPLAY: '   ', WAYLAND_DISPLAY: '' })).toBe(false)
      expect(hasUsableLinuxDisplay({ DISPLAY: ':77' })).toBe(false)
      expect(
        hasUsableLinuxDisplay({ WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' })
      ).toBe(false)
      expect(hasUsableLinuxDisplay({ WAYLAND_DISPLAY: 'wayland-0' })).toBe(false)
    })

    it.each([
      ['localhost:10.0', true],
      ['build-host.example:1', true],
      ['[2001:db8::1]:2.0', true],
      ['tcp/build-host.example:3', true],
      ['garbage', false],
      ['build host:1', false],
      ['build-host.example:', false],
      ['build-host.example:abc', false]
    ])('validates remote X display syntax for %s', async (display, expected) => {
      setPlatform('linux')
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: display })).toBe(expected)
      expect(statSyncMock).not.toHaveBeenCalled()
    })

    it('honors forced X11 and Wayland platform selection', async () => {
      setPlatform('linux')
      statSyncMock.mockImplementation((path: string) => ({
        isSocket: () => path === '/run/user/1000/wayland-0'
      }))
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')
      const env = {
        DISPLAY: ':77',
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_RUNTIME_DIR: '/run/user/1000'
      }

      appMock.commandLine.getSwitchValue.mockReturnValue('x11')
      expect(hasUsableLinuxDisplay(env)).toBe(false)
      appMock.commandLine.getSwitchValue.mockReturnValue('wayland')
      expect(hasUsableLinuxDisplay(env)).toBe(true)

      statSyncMock.mockImplementation((path: string) => ({
        isSocket: () => path === '/tmp/.X11-unix/X0'
      }))
      expect(hasUsableLinuxDisplay({ ...env, DISPLAY: ':0' })).toBe(false)

      appMock.commandLine.getSwitchValue.mockReturnValue('')
      expect(hasUsableLinuxDisplay({ ...env, ELECTRON_OZONE_PLATFORM_HINT: 'x11' })).toBe(false)
    })

    it('never gates a non-Linux platform', async () => {
      setPlatform('darwin')
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({})).toBe(true)
      expect(statSyncMock).not.toHaveBeenCalled()
    })
  })
})
