import { describe, expect, it } from 'vitest'
import {
  commandInRemoteDirectory,
  commandWithNodePath,
  listRelayBaseDirsCommand,
  makeRemoteDirectoryCommand,
  probeRelayInstalledCommand,
  readRemoteHomeCommand,
  relayLivenessProbeCommand,
  tryCreateInstallLockCommand
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

  it('uses -Path for Windows New-Item commands', () => {
    const mkdirScript = decodePowerShellCommand(
      makeRemoteDirectoryCommand(windows, 'C:/Users/me/.orca-remote')
    )
    const lockScript = decodePowerShellCommand(
      tryCreateInstallLockCommand(windows, 'C:/Users/me/.orca-remote/relay/.install-lock')
    )

    expect(mkdirScript).toContain('New-Item -ItemType Directory -Force -Path')
    expect(lockScript).toContain('New-Item -ItemType Directory -Path')
    expect(mkdirScript).not.toContain('New-Item -ItemType Directory -Force -LiteralPath')
    expect(lockScript).not.toContain('New-Item -ItemType Directory -LiteralPath')
  })

  it('uses named pipe try-connect liveness for Windows GC', () => {
    const command = relayLivenessProbeCommand(windows, 'C:/Users/me/.orca-remote/relay-0.1.0', {
      nodePath: 'C:/Program Files/nodejs/node.exe',
      pipePaths: ['\\\\.\\pipe\\orca-relay-1234567890abcdef1234']
    })
    const script = decodePowerShellCommand(command)

    expect(command).toContain('powershell.exe')
    expect(script).toContain('net.connect(pipe)')
    expect(script).toContain('.windows-active-pipe-')
    expect(script).toContain('markerCount===0&&pipes.length===0')
    expect(script).toContain('C:\\Program Files\\nodejs')
    expect(script).not.toContain('Win32_Process')
    expect(listRelayBaseDirsCommand(windows, 'C:/Users/me/.orca-remote')).toContain(
      '-EncodedCommand'
    )
  })

  it('escapes double quotes before passing JavaScript to native Windows commands', () => {
    const script = decodePowerShellCommand(
      relayLivenessProbeCommand(windows, 'C:/Users/me/.orca-remote/relay-0.1.0', {
        nodePath: 'C:/Program Files/nodejs/node.exe',
        pipePaths: ['\\\\.\\pipe\\orca-relay-1234567890abcdef1234']
      })
    )

    expect(script).toContain('fs=require(\\"fs\\")')
    expect(script).toContain('net=require(\\"net\\")')
  })

  it('prepends the Windows node bin directory to PATH with native separators', () => {
    const script = decodePowerShellCommand(
      commandWithNodePath(
        windows,
        'C:/Program Files/nodejs/node.exe',
        'C:/Users/me/.orca-remote/relay-0.1.0',
        "'READY'"
      )
    )

    expect(script).toContain("$env:PATH = 'C:\\Program Files\\nodejs' + ';' + $env:PATH")
  })

  it('keeps the Windows install-lock try/catch parseable', () => {
    const script = decodePowerShellCommand(
      tryCreateInstallLockCommand(windows, 'C:/Users/me/.orca-remote/relay/.install-lock')
    )

    expect(script).toContain('$ErrorActionPreference = "Stop"; try {')
    expect(script).toContain("} catch { 'BUSY' }")
    expect(script).not.toContain('}; catch')
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
