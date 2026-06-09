import { describe, expect, it } from 'vitest'
import {
  listRelayBaseDirsCommand,
  makeRemoteDirectoryCommand,
  probeRelayInstalledCommand,
  readRemoteHomeCommand,
  relayLivenessProbeCommand
} from './ssh-remote-commands'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')

describe('ssh remote command builders', () => {
  it('keeps POSIX deploy commands POSIX-native', () => {
    expect(readRemoteHomeCommand(posix)).toBe('echo $HOME')
    expect(makeRemoteDirectoryCommand(posix, '/home/me/.orca-remote')).toContain('mkdir -p')
    expect(probeRelayInstalledCommand(posix, '/home/me/relay')).toContain('test -d')
  })

  it('uses encoded PowerShell for Windows deploy commands', () => {
    expect(readRemoteHomeCommand(windows)).toContain('powershell.exe')
    expect(makeRemoteDirectoryCommand(windows, 'C:/Users/me/.orca-remote')).toContain(
      '-EncodedCommand'
    )
    expect(probeRelayInstalledCommand(windows, 'C:/Users/me/relay')).toContain('-EncodedCommand')
  })

  it('uses process command-line liveness for Windows GC', () => {
    const command = relayLivenessProbeCommand(windows, 'C:/Users/me/.orca-remote/relay-0.1.0')
    expect(command).toContain('powershell.exe')
    expect(listRelayBaseDirsCommand(windows, 'C:/Users/me/.orca-remote')).toContain(
      '-EncodedCommand'
    )
  })
})
