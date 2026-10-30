import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WslDistroHolder, WslDistroHolderAdoption } from '../wsl/wsl-distro-holder'

const electron = vi.hoisted(() => ({
  userDataPath: '/user-data',
  exit: vi.fn(),
  requestSingleInstanceLock: vi.fn(),
  BrowserWindow: vi.fn(),
  handle: vi.fn()
}))
const appData = vi.hoisted(() => ({ ensure: vi.fn() }))

vi.mock('electron', () => ({
  app: {
    exit: electron.exit,
    getPath: () => electron.userDataPath,
    setPath: vi.fn(),
    requestSingleInstanceLock: electron.requestSingleInstanceLock
  },
  BrowserWindow: electron.BrowserWindow,
  ipcMain: { handle: electron.handle }
}))
vi.mock('./windows-app-data-path', () => ({ ensureWindowsAppDataPath: appData.ensure }))

import {
  releaseWslHoldersForUninstall,
  runWslHolderUninstallPreflight,
  WSL_HOLDER_UNINSTALL_FLAG
} from './wsl-holder-uninstall-preflight'

function holder(release: () => Promise<WslDistroHolderAdoption[]>): WslDistroHolder {
  return {
    ensureHeld: vi.fn(),
    adoptHolders: vi.fn(),
    release: vi.fn(),
    releaseAll: vi.fn(release),
    holderState: vi.fn()
  }
}

describe('WSL holder release on uninstall', () => {
  it('succeeds only when every recorded holder is proven gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const released = holder(async () => [{ distro: 'ubuntu', state: 'exited' }])
    await expect(releaseWslHoldersForUninstall(released)).resolves.toBe(0)
    // Uninstall trusts a matching holder command line; nothing later could release it.
    expect(released.releaseAll).toHaveBeenCalledWith({ forUninstall: true })
    await expect(releaseWslHoldersForUninstall(holder(async () => []))).resolves.toBe(0)
    await expect(
      releaseWslHoldersForUninstall(
        holder(async () => [
          { distro: 'ubuntu', state: 'exited' },
          { distro: 'debian', state: 'unverifiable' }
        ])
      )
    ).resolves.toBe(1)
    await expect(
      releaseWslHoldersForUninstall(
        holder(async () => {
          throw new Error('table unreadable')
        })
      )
    ).resolves.toBe(1)
  })

  it('runs from the uninstaller only, after the app and its daemon are gone', () => {
    const hooks = readFileSync(
      new URL('../../../config/nsis/orca-installer-hooks.nsh', import.meta.url),
      'utf8'
    )
    const unInstall = hooks.slice(hooks.indexOf('!macro customUnInstall'))
    const realUninstall = unInstall.slice(
      unInstall.indexOf('${ifNot} ${isUpdated}'),
      // The real-uninstall branch ends with the relocated daemon host's cleanup.
      unInstall.indexOf('daemon-host-profiles')
    )
    const release = realUninstall.indexOf(
      `nsExec::Exec '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" ${WSL_HOLDER_UNINSTALL_FLAG}'`
    )
    expect(release).toBeGreaterThan(-1)
    // Killed first, so no running Orca can respawn a holder behind the release.
    expect(release).toBeGreaterThan(realUninstall.indexOf('orca-terminal-daemon.exe'))
    expect(hooks.split(WSL_HOLDER_UNINSTALL_FLAG)).toHaveLength(2)
  })

  it('exits 0 with no holder records, and opens no window, lock or IPC', async () => {
    electron.userDataPath = mkdtempSync(join(tmpdir(), 'orca-uninstall-no-holders-'))
    electron.exit.mockClear()
    try {
      expect(runWslHolderUninstallPreflight(['Orca.exe', WSL_HOLDER_UNINSTALL_FLAG])).toBe(true)
      await vi.waitFor(() => expect(electron.exit).toHaveBeenCalledWith(0))
      expect(electron.BrowserWindow).not.toHaveBeenCalled()
      expect(electron.requestSingleInstanceLock).not.toHaveBeenCalled()
      expect(electron.handle).not.toHaveBeenCalled()
    } finally {
      rmSync(electron.userDataPath, { recursive: true, force: true })
    }
  })

  it('exits 1 rather than leaving an error box when setup throws', () => {
    vi.useFakeTimers()
    electron.exit.mockClear()
    appData.ensure.mockImplementationOnce(() => {
      throw new Error('Orca could not find the Windows roaming AppData folder')
    })
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(runWslHolderUninstallPreflight(['Orca.exe', WSL_HOLDER_UNINSTALL_FLAG])).toBe(true)
      expect(electron.exit).toHaveBeenCalledExactlyOnceWith(1)
      // The timer armed before setup is cleared, so it can't exit a second time.
      vi.runAllTimers()
      expect(electron.exit).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('launches from the uninstaller only for a userData that has holder records', () => {
    const hooks = readFileSync(
      new URL('../../../config/nsis/orca-installer-hooks.nsh', import.meta.url),
      'utf8'
    )
    const launch = hooks.indexOf(`--orca-uninstall-release-wsl-holders'`)
    const gate = hooks.lastIndexOf('${if} $1 == "1"', launch)
    expect(gate).toBeGreaterThan(-1)
    expect(hooks.slice(0, gate)).toMatch(
      /\$\{FileExists\} "\$APPDATA\\\$\{APP_PACKAGE_NAME\}\\wsl-distro-holders\\\*\.json"/
    )
  })
})
