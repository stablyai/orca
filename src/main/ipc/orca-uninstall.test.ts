import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'

const { handlers, quit, spawn } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  quit: vi.fn(),
  spawn: vi.fn()
}))
vi.mock('electron', () => ({
  app: { quit, getPath: () => 'C:\\Users\\ada\\AppData', isPackaged: true },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(channel, handler)
  },
  shell: { showItemInFolder: vi.fn() }
}))
vi.mock('../uninstall/orca-install-identity', () => ({
  resolveOrcaInstallIdentity: async () => ({ appPath: 'C:\\Program Files\\Orca' }),
  findWindowsUninstaller: async () => 'C:\\Program Files\\Orca\\Uninstall Orca.exe'
}))
vi.mock('@orca/process-host/isolated-detached-spawn', () => ({
  spawnDetachedWithoutInheritance: spawn
}))
import { registerOrcaUninstallHandlers } from './orca-uninstall'

function launchEmitting(...event: [string, ...unknown[]]): void {
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: () => {} })
    process.nextTick(() => child.emit(...event))
    return child
  })
}

function finish(): Promise<unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: finish never reads the store once the install identity is mocked.
  registerOrcaUninstallHandlers({} as Store)
  return handlers.get('orcaUninstall:finish')!({}, 'open-windows-uninstaller')
}

describe('orcaUninstall:finish open-windows-uninstaller', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    quit.mockReset()
    spawn.mockReset()
  })

  it('keeps Orca open and rejects when Windows refuses to launch the uninstaller', async () => {
    const refused = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
    launchEmitting('error', refused)
    await expect(finish()).rejects.toBe(refused)
    expect(quit).not.toHaveBeenCalled()
  })

  it('quits once the uninstaller has started', async () => {
    launchEmitting('spawn')
    await finish()
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
