import { describe, expect, it, vi } from 'vitest'
import { NsisUpdater } from 'electron-updater/out/NsisUpdater'
import { pinWindowsUpdateInstallDirectory } from './windows-update-install-directory'

function runNsisInstall(updater: object): string[] {
  const spawnLog = vi.fn((_cmd: string, _args: string[]) => Promise.resolve(true))
  // Exercise the real updater so an upstream rename of installDirectory fails here.
  NsisUpdater.prototype['doInstall'].call(
    { ...updater, installerPath: 'C:\\Temp\\orca-windows-setup.exe', spawnLog },
    { isSilent: true, isForceRunAfter: true, isAdminRightsRequired: false }
  )
  return spawnLog.mock.calls[0]?.[1] ?? []
}

describe('pinWindowsUpdateInstallDirectory', () => {
  it('installs a Windows update into the folder the running app was moved to', () => {
    const updater = {}
    pinWindowsUpdateInstallDirectory(updater, 'win32', 'D:\\Apps\\Orca\\Orca.exe')

    expect(runNsisInstall(updater)).toEqual(['--updated', '/S', '--force-run', '/D=D:\\Apps\\Orca'])
  })

  it('leaves other platforms on their default install location', () => {
    const updater = {}
    pinWindowsUpdateInstallDirectory(
      updater,
      'darwin',
      '/Applications/Orca.app/Contents/MacOS/Orca'
    )

    expect(runNsisInstall(updater)).toEqual(['--updated', '/S', '--force-run'])
  })
})
