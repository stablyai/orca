import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NsisUpdater } from 'electron-updater/out/NsisUpdater'
import { resolveWindowsUpdateInstallDirectory } from './windows-update-install-directory'

function runNsisInstall(installDirectory: string | undefined): string[] {
  const spawnLog = vi.fn((_cmd: string, _args: string[]) => Promise.resolve(true))
  // Exercise the real updater so an upstream rename of installDirectory fails here.
  NsisUpdater.prototype['doInstall'].call(
    { installDirectory, installerPath: 'C:\\Temp\\orca-windows-setup.exe', spawnLog },
    { isSilent: true, isForceRunAfter: true, isAdminRightsRequired: false }
  )
  return spawnLog.mock.calls[0]?.[1] ?? []
}

const tempDirectories: string[] = []

function makeFolder(files: string[], directories: string[] = []): string {
  const folder = mkdtempSync(join(tmpdir(), 'orca-win-install-'))
  tempDirectories.push(folder)
  for (const file of files) {
    writeFileSync(join(folder, file), '')
  }
  for (const directory of directories) {
    mkdirSync(join(folder, directory))
  }
  return folder
}

// Top-level files of a real 1.4.245 per-user install.
const INSTALLED_LAYOUT = [
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'dxil.dll',
  'ffmpeg.dll',
  'icudtl.dat',
  'libEGL.dll',
  'libGLESv2.dll',
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
  'Orca.exe',
  'resources.pak',
  'snapshot_blob.bin',
  'Uninstall Orca.exe',
  'v8_context_snapshot.bin',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll'
]

afterEach(() => {
  for (const folder of tempDirectories.splice(0)) {
    rmSync(folder, { recursive: true, force: true })
  }
})

describe('resolveWindowsUpdateInstallDirectory', () => {
  it('installs a Windows update into the folder the installed app was moved to', () => {
    const folder = makeFolder(INSTALLED_LAYOUT, ['locales', 'resources'])
    const installDirectory = resolveWindowsUpdateInstallDirectory('win32', join(folder, 'Orca.exe'))

    expect(runNsisInstall(installDirectory)).toEqual([
      '--updated',
      '/S',
      '--force-run',
      `/D=${folder}`
    ])
  })

  it.each<[string, string[], string[]]>([
    ['an unpacked copy without the uninstaller', ['Orca.exe', 'ffmpeg.dll'], []],
    ['a folder shared with other programs', INSTALLED_LAYOUT, ['OtherApp']],
    ['a folder holding user files', [...INSTALLED_LAYOUT, 'notes.docx'], []]
  ])('keeps the default install location for %s', (_label, files, directories) => {
    const folder = makeFolder(files, directories)
    const installDirectory = resolveWindowsUpdateInstallDirectory('win32', join(folder, 'Orca.exe'))

    expect(runNsisInstall(installDirectory)).toEqual(['--updated', '/S', '--force-run'])
  })

  it('keeps the default install location when the folder path has a space', () => {
    const parent = makeFolder([])
    const folder = join(parent, 'John Smith')
    mkdirSync(folder)
    for (const file of INSTALLED_LAYOUT) {
      writeFileSync(join(folder, file), '')
    }
    const installDirectory = resolveWindowsUpdateInstallDirectory('win32', join(folder, 'Orca.exe'))

    expect(runNsisInstall(installDirectory)).toEqual(['--updated', '/S', '--force-run'])
  })

  it('never pins a drive root', () => {
    const installDirectory = resolveWindowsUpdateInstallDirectory('win32', 'D:\\Orca.exe')

    expect(runNsisInstall(installDirectory)).toEqual(['--updated', '/S', '--force-run'])
  })

  it('leaves other platforms on their default install location', () => {
    const installDirectory = resolveWindowsUpdateInstallDirectory(
      'darwin',
      '/Applications/Orca.app/Contents/MacOS/Orca'
    )

    expect(runNsisInstall(installDirectory)).toEqual(['--updated', '/S', '--force-run'])
  })
})
