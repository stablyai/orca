import { describe, expect, it } from 'vitest'
import {
  detectRuntimeInstall,
  gatherWindowsInstallRoots,
  type RuntimeInstallDetectionInput
} from './runtime-install-detection'

function baseInput(
  overrides: Partial<RuntimeInstallDetectionInput> = {}
): RuntimeInstallDetectionInput {
  return {
    platform: 'linux',
    arch: 'x64',
    isPackaged: true,
    execPath: '/opt/Orca/orca-ide',
    appVersion: '1.2.3',
    appImagePath: null,
    isServeMode: true,
    cgroupContent: null,
    windowsInstallRoots: [],
    linuxPackageOwner: null,
    ...overrides
  }
}

describe('detectRuntimeInstall install kind', () => {
  it('reports source when the app is not packaged', () => {
    const result = detectRuntimeInstall(baseInput({ isPackaged: false }))
    expect(result.installKind).toBe('source')
  })

  it('reports linux-appimage and installPath when APPIMAGE is set', () => {
    const result = detectRuntimeInstall(
      baseInput({
        platform: 'linux',
        appImagePath: '/opt/orca/orca-linux.AppImage'
      })
    )
    expect(result.installKind).toBe('linux-appimage')
    expect(result.installPath).toBe('/opt/orca/orca-linux.AppImage')
  })

  it('reports windows-installer when execPath sits under an NSIS root', () => {
    const result = detectRuntimeInstall(
      baseInput({
        platform: 'win32',
        execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\orca\\Orca.exe',
        windowsInstallRoots: ['C:\\Users\\me\\AppData\\Local\\Programs']
      })
    )
    expect(result.installKind).toBe('windows-installer')
    expect(result.installPath).toBeUndefined()
  })

  it('reports unknown on packaged win32 when execPath is outside every install root', () => {
    const result = detectRuntimeInstall(
      baseInput({
        platform: 'win32',
        execPath: 'D:\\portable\\orca\\Orca.exe',
        windowsInstallRoots: ['C:\\Program Files']
      })
    )
    expect(result.installKind).toBe('unknown')
  })

  it('reports mac-app for an execPath inside a .app bundle', () => {
    const result = detectRuntimeInstall(
      baseInput({
        platform: 'darwin',
        execPath: '/Applications/Orca.app/Contents/MacOS/Orca'
      })
    )
    expect(result.installKind).toBe('mac-app')
  })

  it('never reports mac-homebrew and falls back to unknown outside a bundle', () => {
    const result = detectRuntimeInstall(
      baseInput({
        platform: 'darwin',
        execPath: '/usr/local/bin/orca'
      })
    )
    expect(result.installKind).toBe('unknown')
  })

  it('reports linux-deb only when the startup package probe resolved it', () => {
    const deb = detectRuntimeInstall(
      baseInput({ platform: 'linux', linuxPackageOwner: 'linux-deb' })
    )
    expect(deb.installKind).toBe('linux-deb')

    const unknown = detectRuntimeInstall(baseInput({ platform: 'linux', linuxPackageOwner: null }))
    expect(unknown.installKind).toBe('unknown')
  })
})

describe('detectRuntimeInstall restart kind', () => {
  it('maps a system-slice service cgroup to systemd with its unit name', () => {
    const result = detectRuntimeInstall(
      baseInput({
        platform: 'linux',
        cgroupContent: '0::/system.slice/orca-serve.service\n'
      })
    )
    expect(result.restartKind).toBe('systemd')
    expect(result.serviceName).toBe('orca-serve.service')
  })

  it('trusts a user-slice service only when the unit is an orca unit', () => {
    const result = detectRuntimeInstall(
      baseInput({
        platform: 'linux',
        cgroupContent:
          '0::/user.slice/user-1000.slice/user@1000.service/app.slice/orca-serve.service\n'
      })
    )
    expect(result.restartKind).toBe('systemd')
    expect(result.serviceName).toBe('orca-serve.service')
  })

  it('does NOT map a user-slice terminal service to systemd', () => {
    const result = detectRuntimeInstall(
      baseInput({
        platform: 'linux',
        isServeMode: true,
        cgroupContent:
          '0::/user.slice/user-1000.slice/user@1000.service/app.slice/gnome-terminal-server.service\n'
      })
    )
    expect(result.restartKind).toBe('foreground-serve')
    expect(result.serviceName).toBeUndefined()
  })

  it('maps a foreground orca serve with no systemd markers to foreground-serve', () => {
    const result = detectRuntimeInstall(
      baseInput({ platform: 'linux', isServeMode: true, cgroupContent: null })
    )
    expect(result.restartKind).toBe('foreground-serve')
  })

  it('maps the full desktop app to desktop', () => {
    const result = detectRuntimeInstall(
      baseInput({ platform: 'darwin', isServeMode: false, cgroupContent: null })
    )
    expect(result.restartKind).toBe('desktop')
  })

  it('does not read cgroup off linux', () => {
    const result = detectRuntimeInstall(
      baseInput({
        platform: 'win32',
        isServeMode: false,
        cgroupContent: '0::/system.slice/orca-serve.service\n'
      })
    )
    expect(result.restartKind).toBe('desktop')
    expect(result.serviceName).toBeUndefined()
  })
})

describe('detectRuntimeInstall common fields', () => {
  it('stamps currentVersion and hostArch and leaves latest fields unset', () => {
    const result = detectRuntimeInstall(baseInput({ appVersion: '4.5.6', arch: 'arm64' }))
    expect(result.currentVersion).toBe('4.5.6')
    expect(result.hostArch).toBe('arm64')
    expect(result.latestVersion).toBeUndefined()
    expect(result.updateAvailable).toBeUndefined()
    expect(result.docsUrl).toBeUndefined()
  })
})

describe('gatherWindowsInstallRoots', () => {
  it('derives per-user Programs and machine-wide Program Files roots', () => {
    const roots = gatherWindowsInstallRoots({
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    } as NodeJS.ProcessEnv)
    expect(roots).toContain('C:\\Users\\me\\AppData\\Local\\Programs')
    expect(roots).toContain('C:\\Program Files')
    expect(roots).toContain('C:\\Program Files (x86)')
  })

  it('returns an empty list when no install-root env vars are present', () => {
    expect(gatherWindowsInstallRoots({} as NodeJS.ProcessEnv)).toEqual([])
  })
})
