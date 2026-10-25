import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, existsSyncMock, readFileSyncMock, rmSyncMock, statSyncMock, appMock } =
  vi.hoisted(() => ({
    spawnMock: vi.fn(),
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

vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock,
  statSync: statSyncMock
}))
vi.mock('electron', () => ({ app: appMock }))

const OWN_UID = 1000
const OTHER_UID = 1001
const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_GETUID = Object.getOwnPropertyDescriptor(process, 'getuid')
const ORIGINAL_DISPLAY = process.env.DISPLAY

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  // Simulated Linux still needs a UID when the Windows test host lacks getuid.
  Object.defineProperty(process, 'getuid', {
    value: () => OWN_UID,
    configurable: true,
    writable: true
  })
}

function mockLiveXDisplay(pid = 4321): void {
  statSyncMock.mockReturnValue({ isSocket: () => true, uid: OWN_UID })
  existsSyncMock.mockReturnValue(true)
  readFileSyncMock.mockReturnValue(`${pid}\n`)
  vi.spyOn(process, 'kill').mockImplementation(() => true)
}

function mockXvfbTakesDisplay(pid = 1234): void {
  let bound = false
  statSyncMock.mockImplementation(() => ({ isSocket: () => true, uid: OWN_UID }))
  readFileSyncMock.mockImplementation(() => {
    if (!bound) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return `${pid}\n`
  })
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  spawnMock.mockImplementation(() => {
    bound = true
    return { pid, once: vi.fn(), kill: vi.fn(), killed: false }
  })
}

describe('ensureVirtualDisplayForHeadlessServe', () => {
  beforeEach(() => {
    spawnMock.mockReset()
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
    if (ORIGINAL_GETUID) {
      Object.defineProperty(process, 'getuid', ORIGINAL_GETUID)
    } else {
      Reflect.deleteProperty(process, 'getuid')
    }
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

  it('reports unsupported when Xvfb cannot be launched', async () => {
    setPlatform('linux')
    statSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    spawnMock.mockReturnValue({ pid: undefined, once: vi.fn(), kill: vi.fn(), killed: false })
    const {
      ensureVirtualDisplayForHeadlessServe,
      MISSING_LINUX_DISPLAY_MESSAGE,
      MISSING_SERVE_DISPLAY_MESSAGE,
      missingLinuxDisplayMessage
    } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(false)
    expect(spawnMock).toHaveBeenCalledWith('Xvfb', expect.any(Array), expect.any(Object))
    expect(MISSING_LINUX_DISPLAY_MESSAGE).toContain('endpoint is unavailable')
    expect(MISSING_LINUX_DISPLAY_MESSAGE).toContain('XDG_RUNTIME_DIR')
    for (const message of [MISSING_LINUX_DISPLAY_MESSAGE, MISSING_SERVE_DISPLAY_MESSAGE]) {
      expect(message).toContain('`xvfb` on Debian/Ubuntu')
      expect(message).toContain('`xorg-x11-server-Xvfb`')
      expect(message).toContain('`xorg-server-xvfb` on Arch')
    }
    expect(MISSING_SERVE_DISPLAY_MESSAGE).not.toContain('orca-ide serve')
    expect(MISSING_SERVE_DISPLAY_MESSAGE).toContain('Wayland alone is not enough')
    expect(missingLinuxDisplayMessage(true)).toBe(MISSING_SERVE_DISPLAY_MESSAGE)
    expect(missingLinuxDisplayMessage(false)).toBe(MISSING_LINUX_DISPLAY_MESSAGE)
  })

  it('leaves an externally configured stale display untouched', async () => {
    setPlatform('linux')
    process.env.DISPLAY = ':77'
    statSyncMock.mockReturnValue({ isSocket: () => true, uid: OWN_UID })
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockImplementation(() => {
      throw new Error('display lock is outside this namespace')
    })
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(rmSyncMock).not.toHaveBeenCalled()
    expect(process.env.DISPLAY).toBe(':77')
  })

  // #15084: containers may expose an external X socket without its host lock/PID.
  it('serves on an externally configured display that has no lock file', async () => {
    setPlatform('linux')
    process.env.DISPLAY = ':0'
    statSyncMock.mockReturnValue({ isSocket: () => true, uid: OWN_UID })
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(rmSyncMock).not.toHaveBeenCalled()
    expect(process.env.DISPLAY).toBe(':0')
  })

  // Cleanup unlinks lock first; trusting Orca's own lockless :99 would revive an orphan socket.
  it('does not adopt its own :99 socket when the lock is missing', async () => {
    setPlatform('linux')
    existsSyncMock.mockReturnValue(true)
    mockXvfbTakesDisplay()
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    expect(rmSyncMock).toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledWith(
      'Xvfb',
      expect.arrayContaining([':99']),
      expect.any(Object)
    )
  })

  it('reuses an existing virtual display only when its X server is alive', async () => {
    setPlatform('linux')
    statSyncMock.mockReturnValue({ isSocket: () => true, uid: OWN_UID })
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue('4321\n')
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
    existsSyncMock.mockReturnValue(true)
    let bound = false
    statSyncMock.mockImplementation(() => ({ isSocket: () => true, uid: OWN_UID }))
    readFileSyncMock.mockImplementation(() => (bound ? '1234\n' : '9999\n'))
    // Only the newly spawned Xvfb is alive; the orphan lock PID is dead.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 9999) {
        throw new Error('ESRCH')
      }
      return true as never
    })
    spawnMock.mockImplementation(() => {
      bound = true
      return { pid: 1234, once: vi.fn(), kill: vi.fn(), killed: false }
    })
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    expect(rmSyncMock).toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledWith(
      'Xvfb',
      expect.arrayContaining([':99', '-terminate']),
      expect.objectContaining({ detached: true })
    )
    expect(process.env.DISPLAY).toBe(':99')
    killSpy.mockRestore()
  })

  // A foreign stale socket can prevent bind; trusting it advertised a dead display and crashed Ozone initialization.
  it('reports failure when a stale socket blocks the Xvfb rebind', async () => {
    setPlatform('linux')
    statSyncMock.mockReturnValue({ isSocket: () => true, uid: OWN_UID })
    // Foreign ownership prevents unlink and Xvfb never acquires the display.
    rmSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    spawnMock.mockReturnValue({ pid: 4242, once: vi.fn(), kill: vi.fn(), killed: false })
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    vi.useFakeTimers({ toFake: ['Date'] })
    const sleep = vi
      .spyOn(Atomics, 'wait')
      .mockImplementation((_array, _index, _value, timeout) => {
        vi.setSystemTime(Date.now() + (timeout ?? 0))
        return 'timed-out'
      })
    try {
      expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(false)
      expect(process.env.DISPLAY).toBeUndefined()
    } finally {
      sleep.mockRestore()
      vi.useRealTimers()
    }
  })

  it('accepts the display once the spawned Xvfb owns its lock', async () => {
    setPlatform('linux')
    let lockWritten = false
    statSyncMock.mockImplementation(() => ({ isSocket: () => lockWritten, uid: OWN_UID }))
    rmSyncMock.mockImplementation(() => {})
    readFileSyncMock.mockImplementation(() => {
      if (!lockWritten) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return '4242\n'
    })
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    spawnMock.mockImplementation(() => {
      lockWritten = true
      return { pid: 4242, once: vi.fn(), kill: vi.fn(), killed: false }
    })
    const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

    expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
    expect(process.env.DISPLAY).toBe(':99')
  })

  describe('with several accounts on one machine (#26602)', () => {
    type FakeDisplay = { uid: number; lockPid: number | null; socket: boolean }

    // Model independent artifacts/ownership for each candidate display.
    function mockDisplays(displays: Record<number, FakeDisplay>, alivePids: number[]): void {
      const displayOf = (path: string): FakeDisplay | undefined => {
        const match = /(?:\.X(\d+)-lock|X11-unix\/X(\d+))$/.exec(path)
        return match ? displays[Number(match[1] ?? match[2])] : undefined
      }
      const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      statSyncMock.mockImplementation((path: string) => {
        const display = displayOf(path)
        const isLock = path.endsWith('-lock')
        if (!display || (isLock ? display.lockPid === null : !display.socket)) {
          throw enoent()
        }
        return { uid: display.uid, isSocket: () => !isLock }
      })
      readFileSyncMock.mockImplementation((path: string) => {
        if (path === '/proc/net/unix') {
          return ''
        }
        const display = displayOf(path)
        if (!display || display.lockPid === null) {
          throw enoent()
        }
        return `${display.lockPid}\n`
      })
      vi.spyOn(process, 'kill').mockImplementation((pid) => {
        if (!alivePids.includes(Number(pid))) {
          throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
        }
        return true
      })
      let nextPid = 5000
      spawnMock.mockImplementation((_command: string, args: string[]) => {
        const pid = nextPid++
        alivePids.push(pid)
        const displayNumber = Number(args[0].slice(1))
        if (!displays[displayNumber]) {
          displays[displayNumber] = { uid: OWN_UID, lockPid: pid, socket: true }
        }
        return { pid, once: vi.fn(), kill: vi.fn(), killed: false }
      })
    }

    it("starts its own display instead of attaching to another account's live :99", async () => {
      setPlatform('linux')
      mockDisplays({ 99: { uid: OTHER_UID, lockPid: 777, socket: true } }, [777])
      const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

      expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
      expect(process.env.DISPLAY).toBe(':100')
      expect(spawnMock).toHaveBeenCalledWith(
        'Xvfb',
        expect.arrayContaining([':100']),
        expect.any(Object)
      )
      expect(rmSyncMock).not.toHaveBeenCalled()
    })

    it("skips another account's stale :99 that sticky /tmp keeps it from removing", async () => {
      setPlatform('linux')
      mockDisplays({ 99: { uid: OTHER_UID, lockPid: 777, socket: true } }, [])
      const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

      expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
      expect(process.env.DISPLAY).toBe(':100')
      expect(rmSyncMock).not.toHaveBeenCalled()
    })

    it('reuses its own live display past the ones other accounts hold', async () => {
      setPlatform('linux')
      mockDisplays(
        {
          99: { uid: OTHER_UID, lockPid: 777, socket: true },
          100: { uid: OWN_UID, lockPid: 888, socket: true }
        },
        [777, 888]
      )
      const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

      expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
      expect(process.env.DISPLAY).toBe(':100')
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it("leaves its own account's display alone while that server is still starting", async () => {
      setPlatform('linux')
      // :99 has its live lock but no socket yet.
      mockDisplays({ 99: { uid: OWN_UID, lockPid: 888, socket: false } }, [888])
      const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

      expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
      expect(process.env.DISPLAY).toBe(':100')
      expect(rmSyncMock).not.toHaveBeenCalled()
    })

    it('does not accept a spawned Xvfb that died after writing its lock and socket', async () => {
      setPlatform('linux')
      const alive: number[] = []
      mockDisplays({}, alive)
      const startXvfb = spawnMock.getMockImplementation()!
      spawnMock.mockImplementation((command: string, args: string[]) => {
        const child = startXvfb(command, args)
        alive.splice(alive.indexOf(child.pid), 1)
        return child
      })
      const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

      vi.useFakeTimers({ toFake: ['Date'] })
      const sleep = vi
        .spyOn(Atomics, 'wait')
        .mockImplementation((_array, _index, _value, timeout) => {
          vi.setSystemTime(Date.now() + (timeout ?? 0))
          return 'timed-out'
        })
      try {
        expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(false)
        expect(process.env.DISPLAY).toBeUndefined()
      } finally {
        sleep.mockRestore()
        vi.useRealTimers()
      }
    })

    it('moves on when another server wins the free display first', async () => {
      setPlatform('linux')
      const displays: Record<number, FakeDisplay> = {}
      mockDisplays(displays, [777])
      const startXvfb = spawnMock.getMockImplementation()!
      spawnMock.mockImplementationOnce((command: string, args: string[]) => {
        // Model another account winning the bind race.
        displays[99] = { uid: OTHER_UID, lockPid: 777, socket: true }
        return startXvfb(command, args)
      })
      const { ensureVirtualDisplayForHeadlessServe } = await import('./ensure-virtual-display')

      expect(ensureVirtualDisplayForHeadlessServe({ isServeMode: true })).toBe(true)
      expect(process.env.DISPLAY).toBe(':100')
      expect(spawnMock).toHaveBeenCalledTimes(2)
    })
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

    // Abstract sockets are kernel-owned and vanish on exit, so their presence proves a live server.
    it('accepts an abstract-namespace X socket with no filesystem socket', async () => {
      setPlatform('linux')
      statSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      readFileSyncMock.mockImplementation((path: string) => {
        if (path === '/proc/net/unix') {
          return [
            'Num       RefCount Protocol Flags    Type St Inode Path',
            '0000000000000000: 00000003 00000000 00000000 0001 03 12014 @/tmp/.X11-unix/X0',
            ''
          ].join('\n')
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: ':0' })).toBe(true)
    })

    it('does not confuse a different display number in the abstract table', async () => {
      setPlatform('linux')
      statSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      readFileSyncMock.mockImplementation((path: string) => {
        if (path === '/proc/net/unix') {
          return '0000000000000000: 00000003 00000000 00000000 0001 03 12014 @/tmp/.X11-unix/X10\n'
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: ':1' })).toBe(false)
    })

    it('accepts an inherited WAYLAND_SOCKET fd with no WAYLAND_DISPLAY', async () => {
      setPlatform('linux')
      statSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      readFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ WAYLAND_SOCKET: '7' })).toBe(true)
      expect(hasUsableLinuxDisplay({ WAYLAND_SOCKET: 'not-an-fd' })).toBe(false)
    })

    // Own lockless :99 can be half-finished teardown even when inherited DISPLAY names it.
    it('does not trust a lockless socket on its own managed display number', async () => {
      setPlatform('linux')
      statSyncMock.mockReturnValue({ isSocket: () => true, uid: OWN_UID })
      readFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: ':99' })).toBe(false)
      expect(hasUsableLinuxDisplay({ DISPLAY: ':0' })).toBe(true)
    })

    it('rejects an orphaned local X11 socket whose server PID is gone', async () => {
      setPlatform('linux')
      statSyncMock.mockReturnValue({ isSocket: () => true, uid: OWN_UID })
      existsSyncMock.mockReturnValue(true)
      readFileSyncMock.mockReturnValue('9999\n')
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      })
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: ':77' })).toBe(false)
      expect(readFileSyncMock).toHaveBeenCalledWith('/tmp/.X77-lock', 'utf8')
    })

    // External lockless sockets can come from container mounts/WSLg; a crashed local X server leaves its lock too.
    it('accepts a local X11 socket published without a lock file', async () => {
      setPlatform('linux')
      statSyncMock.mockReturnValue({ isSocket: () => true, uid: OWN_UID })
      readFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const killSpy = vi.spyOn(process, 'kill')
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: ':0' })).toBe(true)
      expect(hasUsableLinuxDisplay({ DISPLAY: ':100' })).toBe(true)
      expect(killSpy).not.toHaveBeenCalled()
    })

    // Pinned X11 cannot rely on a Wayland fallback in WSLg.
    it('accepts a lockless X11 socket when x11 is pinned and Wayland is unavailable', async () => {
      setPlatform('linux')
      statSyncMock.mockImplementation((path: string) => ({
        isSocket: () => path === '/tmp/.X11-unix/X0'
      }))
      readFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: ':0', ELECTRON_OZONE_PLATFORM_HINT: 'x11' })).toBe(
        true
      )
    })

    it('still rejects a missing socket even when no lock file exists', async () => {
      setPlatform('linux')
      statSyncMock.mockReturnValue({ isSocket: () => false })
      readFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: ':0' })).toBe(false)
    })

    it('rejects a lock that exists but cannot be read', async () => {
      setPlatform('linux')
      statSyncMock.mockReturnValue({ isSocket: () => true, uid: OWN_UID })
      readFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      })
      const { hasUsableLinuxDisplay } = await import('./ensure-virtual-display')

      expect(hasUsableLinuxDisplay({ DISPLAY: ':0' })).toBe(false)
    })

    it('accepts a live local X11 server owned by another user', async () => {
      setPlatform('linux')
      statSyncMock.mockReturnValue({ isSocket: () => true, uid: OWN_UID })
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
