import type * as fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAppImageRuntimeIdentity } from '../appimage-runtime-identity'
import { installAppImageCrashpadHandlerExit } from './appimage-crashpad-handler-exit'

vi.mock('../appimage-runtime-identity', () => ({
  resolveAppImageRuntimeIdentity: vi.fn()
}))

const MOUNT = '/tmp/.mount_Orca-abc123'
const PROC_EXECUTABLES: Record<string, string> = {
  '40': `${MOUNT}/chrome_crashpad_handler`,
  '41': `${MOUNT}/chrome_crashpad_handler`,
  '42': `${MOUNT}/orca-ide`,
  // Another launch's mount, and a handler whose mount is already gone.
  '43': '/tmp/.mount_Orca-zzz999/chrome_crashpad_handler',
  '44': '/chrome_crashpad_handler'
}

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  readdirSync: vi.fn(() => [...Object.keys(PROC_EXECUTABLES), '45', 'self']),
  readlinkSync: vi.fn((path: string) => {
    const executable = PROC_EXECUTABLES[path.split('/')[2]]
    if (!executable) {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    }
    return executable
  }),
  // Only the FUSE mount root sits on its own device.
  statSync: vi.fn((path: string) => ({ dev: path === MOUNT ? 2 : 1 }))
}))

describe('installAppImageCrashpadHandlerExit', () => {
  const originalExecPath = process.execPath

  afterEach(() => {
    process.execPath = originalExecPath
    vi.restoreAllMocks()
  })

  function installExitHook(
    isAppImage: boolean,
    execPath = `${MOUNT}/orca-ide`
  ): (() => void) | undefined {
    process.execPath = execPath
    vi.mocked(resolveAppImageRuntimeIdentity).mockReturnValue(
      isAppImage ? { appImagePath: '/home/u/orca-linux.AppImage' } : null
    )
    const once = vi.spyOn(process, 'once').mockReturnValue(process)
    installAppImageCrashpadHandlerExit()
    return once.mock.calls.find(([event]) => event === 'exit')?.[1]
  }

  it('SIGKILLs only this launch handler, surviving one that already exited', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 40) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      }
      return true
    })

    installExitHook(true)?.()

    expect(kill.mock.calls).toEqual([
      [40, 'SIGKILL'],
      [41, 'SIGKILL']
    ])
  })

  // A deb/rpm handler binary is shared by every instance, so it must never be matched.
  it('does not hook exit outside a validated AppImage', () => {
    expect(installExitHook(false)).toBeUndefined()
  })

  it('does not hook exit under extract-and-run, whose dir is shared across launches', () => {
    expect(installExitHook(true, '/tmp/appimage_extracted_0123abcd/orca-ide')).toBeUndefined()
  })
})
