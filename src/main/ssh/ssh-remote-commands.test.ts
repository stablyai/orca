import { describe, expect, it } from 'vitest'
import {
  commandInRemoteDirectory,
  commandWithNodePath,
  listRelayBaseDirsCommand,
  makeRemoteDirectoryCommand,
  probeRelayInstalledCommand,
  readRemoteHomeCommand,
  relayLivenessProbeCommand
} from './ssh-remote-commands'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')

function decodePowerShellCommand(command: string): string {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : ''
}

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

  it('makes Windows remote directory changes fail before running scoped commands', () => {
    const scopedCommand = decodePowerShellCommand(
      commandInRemoteDirectory(windows, 'C:/Users/me/.orca-remote/relay-0.1.0', "'READY'")
    )
    const nodeScopedCommand = decodePowerShellCommand(
      commandWithNodePath(
        windows,
        'C:/Program Files/nodejs/node.exe',
        'C:/Users/me/.orca-remote/relay-0.1.0',
        "'READY'"
      )
    )

    expect(scopedCommand).toContain(
      "Set-Location -ErrorAction Stop -LiteralPath 'C:/Users/me/.orca-remote/relay-0.1.0'"
    )
    expect(nodeScopedCommand).toContain(
      "Set-Location -ErrorAction Stop -LiteralPath 'C:/Users/me/.orca-remote/relay-0.1.0'"
    )
  })
})
