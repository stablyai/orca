import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedPwshAvailability } from '../pwsh'
import { localLaunchArtifactsWritable } from '../providers/local-launch-artifact-directory'
import { wslLaunchDirectoryKnownBroken } from '../providers/wsl-launch-directory-resolution'
import { thisOrcaLaunchHost } from './this-orca-launch-host'

vi.mock('../pwsh', () => ({ cachedPwshAvailability: vi.fn(() => null) }))
vi.mock('../providers/local-launch-artifact-directory', () => ({
  localLaunchArtifactsWritable: vi.fn(() => true)
}))
vi.mock('../providers/wsl-launch-directory-resolution', () => ({
  wslLaunchDirectoryKnownBroken: vi.fn(() => false)
}))

const realPlatform = process.platform

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

// Why: this Orca spawns its own Windows panes, so it knows the PowerShell that gets the line.
describe('the PowerShell a launch this Orca runs lands in', () => {
  afterEach(() => {
    onPlatform(realPlatform)
    vi.mocked(cachedPwshAvailability).mockReturnValue(null)
  })

  it('follows the requested shell, then the settings and the pwsh probe, on this Windows machine', () => {
    onPlatform('win32')
    const settings = {
      terminalWindowsShell: 'powershell.exe',
      terminalWindowsPowerShellImplementation: 'auto' as const
    }
    const host = (windowsShellOverride?: string) =>
      thisOrcaLaunchHost({
        launchPlatform: 'win32',
        isRemote: false,
        settings,
        windowsShellOverride
      })
    expect(host().windowsPaneShell).toBeNull()
    vi.mocked(cachedPwshAvailability).mockReturnValue(false)
    expect(host().windowsPaneShell).toBe('powershell.exe')
    expect(host('pwsh.exe').windowsPaneShell).toBe('pwsh.exe')
    expect(
      thisOrcaLaunchHost({ launchPlatform: 'win32', isRemote: true, settings }).windowsPaneShell
    ).toBeNull()
  })

  it('knows none for a launch on another platform', () => {
    onPlatform('darwin')
    vi.mocked(cachedPwshAvailability).mockReturnValue(true)
    expect(
      thisOrcaLaunchHost({
        launchPlatform: 'win32',
        isRemote: false,
        settings: { terminalWindowsShell: 'pwsh.exe' }
      }).windowsPaneShell
    ).toBeNull()
  })
})

// Why: a host that cannot write its staging folder can neither stage a line nor write a launch
// file there, so the launch is planned for main's delivery up front instead of refused.
describe('whether a launch this Orca runs can write its staging folder', () => {
  afterEach(() => {
    onPlatform(realPlatform)
    vi.mocked(localLaunchArtifactsWritable).mockReturnValue(true)
    vi.mocked(wslLaunchDirectoryKnownBroken).mockReturnValue(false)
  })

  it('follows this machine’s temp folder for a local launch', () => {
    const host = () =>
      thisOrcaLaunchHost({ launchPlatform: 'darwin', isRemote: false, settings: null })
    onPlatform('darwin')
    expect(host().takesLaunchFile).toBe(true)
    vi.mocked(localLaunchArtifactsWritable).mockReturnValue(false)
    expect(host().takesLaunchFile).toBe(false)
  })

  it('follows the distro’s folder for a WSL workspace', () => {
    onPlatform('win32')
    vi.mocked(wslLaunchDirectoryKnownBroken).mockImplementation((distro) => distro === 'qasfwin')
    const host = (workspacePath: string) =>
      thisOrcaLaunchHost({
        launchPlatform: 'linux',
        isRemote: false,
        settings: null,
        workspacePath
      })
    expect(host('\\\\wsl.localhost\\qasfwin\\root\\fixture').takesLaunchFile).toBe(false)
    expect(host('\\\\wsl.localhost\\Ubuntu\\home\\ada').takesLaunchFile).toBe(true)
  })

  it('cannot check an SSH host’s folder from here', () => {
    vi.mocked(localLaunchArtifactsWritable).mockReturnValue(false)
    expect(
      thisOrcaLaunchHost({ launchPlatform: 'linux', isRemote: true, settings: null })
        .takesLaunchFile
    ).toBe(true)
  })
})
