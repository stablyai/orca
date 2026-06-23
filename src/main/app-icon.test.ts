import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  browserWindowGetAllWindowsMock,
  createFromPathMock,
  dockSetIconMock,
  isMock,
  windowSetIconMock
} = vi.hoisted(() => ({
  browserWindowGetAllWindowsMock: vi.fn(),
  createFromPathMock: vi.fn(),
  dockSetIconMock: vi.fn(),
  isMock: { dev: false },
  windowSetIconMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { dock: { setIcon: dockSetIconMock } },
  BrowserWindow: { getAllWindows: browserWindowGetAllWindowsMock },
  nativeImage: { createFromPath: createFromPathMock }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: isMock
}))

vi.mock('../../resources/icon.png?asset', () => ({
  default: 'classic-icon'
}))

vi.mock('../../resources/icon-dev.png?asset', () => ({
  default: 'classic-dev-icon'
}))

vi.mock('../../resources/app-icons/orca-watercolor.png?asset', () => ({
  default: 'watercolor-icon'
}))

vi.mock('../../resources/app-icons/orca-watercolor.png?asset&asarUnpack', () => ({
  default: 'watercolor-icon-unpacked'
}))

vi.mock('../../resources/app-icons/orca-blue.png?asset', () => ({
  default: 'blue-icon'
}))

vi.mock('../../resources/app-icons/orca-blue.png?asset&asarUnpack', () => ({
  default: 'blue-icon-unpacked'
}))

import { applyAppIcon, getAppIconPath, persistMacDockIcon } from './app-icon'

function waitForQueuedPersistence(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitForQueuedPersistenceMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function createMockChildProcess(): EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  const childProcess = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
  childProcess.kill = vi.fn(() => {
    childProcess.emit('exit')
    return true
  })
  return childProcess
}

describe('app icon selection', () => {
  beforeEach(() => {
    browserWindowGetAllWindowsMock.mockReset()
    createFromPathMock.mockReset()
    dockSetIconMock.mockReset()
    windowSetIconMock.mockReset()
    isMock.dev = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves classic, watercolor, blue, and invalid icon ids', () => {
    expect(getAppIconPath('classic')).toBe('classic-icon')
    expect(getAppIconPath('watercolor')).toBe('watercolor-icon')
    expect(getAppIconPath('blue')).toBe('blue-icon')
    expect(getAppIconPath('missing')).toBe('classic-icon')
  })

  it('applies the selected icon to the dock and live windows', () => {
    const image = { isEmpty: () => false }
    createFromPathMock.mockReturnValue(image)
    browserWindowGetAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, setIcon: windowSetIconMock },
      { isDestroyed: () => true, setIcon: vi.fn() }
    ])

    applyAppIcon('watercolor')

    expect(createFromPathMock).toHaveBeenCalledWith('watercolor-icon')
    if (process.platform === 'darwin') {
      expect(dockSetIconMock).toHaveBeenCalledWith(image)
    } else {
      expect(dockSetIconMock).not.toHaveBeenCalled()
    }
    expect(windowSetIconMock).toHaveBeenCalledWith(image)
  })

  it('persists a custom macOS dock icon to the app bundle for inactive Dock pins', async () => {
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        optionsOrCallback: unknown,
        callback?: (error: Error | null) => void
      ) => {
        const onComplete =
          typeof optionsOrCallback === 'function'
            ? (optionsOrCallback as (error: Error | null) => void)
            : callback
        onComplete?.(null)
      }
    )

    persistMacDockIcon('watercolor', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })
    await waitForQueuedPersistence()

    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      expect.arrayContaining(['-e', expect.stringContaining('setIcon:image forFile:appPath')]),
      expect.objectContaining({
        env: expect.objectContaining({
          ORCA_APP_BUNDLE_PATH: '/Applications/Orca.app',
          ORCA_APP_ICON_PATH: 'watercolor-icon-unpacked'
        })
      }),
      expect.any(Function)
    )
  })

  it('clears the AppKit icon and Finder metadata when switching macOS back to classic', async () => {
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        optionsOrCallback: unknown,
        callback?: (error: Error | null) => void
      ) => {
        const onComplete =
          typeof optionsOrCallback === 'function'
            ? (optionsOrCallback as (error: Error | null) => void)
            : callback
        onComplete?.(null)
      }
    )

    persistMacDockIcon('classic', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })
    await waitForQueuedPersistence()

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      '/usr/bin/osascript',
      expect.arrayContaining([
        '-e',
        expect.stringContaining('setIcon:(missing value) forFile:appPath')
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          ORCA_APP_BUNDLE_PATH: '/Applications/Orca.app'
        }),
        timeout: 10_000
      }),
      expect.any(Function)
    )
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/xattr',
      ['-d', 'com.apple.FinderInfo', '/Applications/Orca.app'],
      expect.objectContaining({
        timeout: 10_000
      }),
      expect.any(Function)
    )
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/xattr',
      ['-d', 'com.apple.ResourceFork', '/Applications/Orca.app'],
      expect.objectContaining({
        timeout: 10_000
      }),
      expect.any(Function)
    )
  })

  it('warns for non-benign failures when clearing Finder custom icon metadata', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execFile = vi.fn(
      (
        file: string,
        args: string[],
        optionsOrCallback: unknown,
        callback?: (error: Error | null) => void
      ) => {
        const onComplete =
          typeof optionsOrCallback === 'function'
            ? (optionsOrCallback as (error: Error | null) => void)
            : callback
        if (file !== '/usr/bin/xattr') {
          onComplete?.(null)
          return
        }
        onComplete?.(new Error(args[1] === 'com.apple.FinderInfo' ? 'No such xattr' : 'EACCES'))
      }
    )

    persistMacDockIcon('classic', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })
    await waitForQueuedPersistence()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[app-icon] failed to clear macOS dock icon metadata com.apple.ResourceFork:',
      expect.any(Error)
    )

    warnSpy.mockRestore()
  })

  it('warns when the AppKit classic icon reset fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execFile = vi.fn(
      (
        file: string,
        _args: string[],
        optionsOrCallback: unknown,
        callback?: (error: Error | null) => void
      ) => {
        const onComplete =
          typeof optionsOrCallback === 'function'
            ? (optionsOrCallback as (error: Error | null) => void)
            : callback
        onComplete?.(file === '/usr/bin/osascript' ? new Error('reset denied') : null)
      }
    )

    persistMacDockIcon('classic', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })
    await waitForQueuedPersistence()

    expect(warnSpy).toHaveBeenCalledWith(
      '[app-icon] failed to clear macOS dock icon:',
      expect.any(Error)
    )

    warnSpy.mockRestore()
  })

  it('serializes rapid macOS dock icon persistence so the last icon request wins', async () => {
    const pendingCallbacks: (() => void)[] = []
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        optionsOrCallback: unknown,
        callback?: (error: Error | null) => void
      ) => {
        const onComplete =
          typeof optionsOrCallback === 'function'
            ? (optionsOrCallback as (error: Error | null) => void)
            : callback
        pendingCallbacks.push(() => onComplete?.(null))
      }
    )

    persistMacDockIcon('watercolor', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })
    await waitForQueuedPersistence()

    persistMacDockIcon('blue', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })
    persistMacDockIcon('classic', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })

    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          ORCA_APP_ICON_PATH: 'watercolor-icon-unpacked'
        })
      }),
      expect.any(Function)
    )

    pendingCallbacks.shift()?.()
    await waitForQueuedPersistence()

    expect(execFile).toHaveBeenCalledTimes(2)
    expect(execFile).not.toHaveBeenCalledWith(
      '/usr/bin/osascript',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          ORCA_APP_ICON_PATH: 'blue-icon-unpacked'
        })
      }),
      expect.any(Function)
    )
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/osascript',
      expect.arrayContaining([
        '-e',
        expect.stringContaining('setIcon:(missing value) forFile:appPath')
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          ORCA_APP_BUNDLE_PATH: '/Applications/Orca.app'
        }),
        timeout: 10_000
      }),
      expect.any(Function)
    )
    pendingCallbacks.shift()?.()
    await waitForQueuedPersistence()

    expect(execFile).toHaveBeenCalledTimes(4)
    expect(execFile).toHaveBeenNthCalledWith(
      3,
      '/usr/bin/xattr',
      ['-d', 'com.apple.FinderInfo', '/Applications/Orca.app'],
      expect.objectContaining({
        timeout: 10_000
      }),
      expect.any(Function)
    )
    expect(execFile).toHaveBeenNthCalledWith(
      4,
      '/usr/bin/xattr',
      ['-d', 'com.apple.ResourceFork', '/Applications/Orca.app'],
      expect.objectContaining({
        timeout: 10_000
      }),
      expect.any(Function)
    )

    for (const completeCommand of pendingCallbacks) {
      completeCommand()
    }
    await waitForQueuedPersistence()
  })

  it('continues macOS dock icon persistence when a command never completes', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hungChildProcess = createMockChildProcess()
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        optionsOrCallback: unknown,
        callback?: (error: Error | null) => void
      ) => {
        if (execFile.mock.calls.length === 1) {
          return hungChildProcess
        }
        const onComplete =
          typeof optionsOrCallback === 'function'
            ? (optionsOrCallback as (error: Error | null) => void)
            : callback
        onComplete?.(null)
        return undefined
      }
    )

    persistMacDockIcon('watercolor', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })
    await waitForQueuedPersistenceMicrotasks()

    persistMacDockIcon('blue', {
      appBundlePath: '/Applications/Orca.app',
      execFile,
      isDevApp: false,
      platform: 'darwin'
    })

    expect(execFile).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    await waitForQueuedPersistenceMicrotasks()

    expect(hungChildProcess.kill).not.toHaveBeenCalled()
    expect(execFile).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await waitForQueuedPersistenceMicrotasks()

    expect(warnSpy).toHaveBeenCalledWith('[app-icon] timed out persisting macOS dock icon')
    expect(hungChildProcess.kill).toHaveBeenCalledTimes(1)
    expect(execFile).toHaveBeenCalledTimes(2)
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/osascript',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          ORCA_APP_ICON_PATH: 'blue-icon-unpacked'
        }),
        timeout: 10_000
      }),
      expect.any(Function)
    )

    warnSpy.mockRestore()
  })
})
