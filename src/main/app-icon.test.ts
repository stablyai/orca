import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { dockSetIconMock } = vi.hoisted(() => ({ dockSetIconMock: vi.fn() }))

vi.mock('electron', () => ({
  app: { isPackaged: true, dock: { setIcon: dockSetIconMock } },
  nativeImage: { createEmpty: () => ({ isEmpty: () => true }) }
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

import { persistMacDockIcon } from './app-icon'

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
  afterEach(() => {
    vi.useRealTimers()
  })

  it('restores the bundle Dock icon only after the custom icon clear succeeds', async () => {
    const persistClassic = (clearError: Error | null): Promise<void> => {
      persistMacDockIcon('classic', {
        appBundlePath: '/Applications/Orca.app',
        execFile: (file, _args, _options, callback) =>
          callback?.(file === '/usr/bin/osascript' ? clearError : null),
        isDevApp: false,
        platform: 'darwin'
      })
      return waitForQueuedPersistence()
    }

    dockSetIconMock.mockClear()
    await persistClassic(new Error('clear failed'))
    expect(dockSetIconMock).not.toHaveBeenCalled()
    await persistClassic(null)
    expect(dockSetIconMock.mock.lastCall?.[0].isEmpty()).toBe(true)
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
