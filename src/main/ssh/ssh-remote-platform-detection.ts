import type { SshConnection } from './ssh-connection'
import { parseUnameToRelayPlatform, type RelayPlatform } from './relay-protocol'
import { execCommand } from './ssh-relay-deploy-helpers'
import { getRemoteHostPlatform, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'

export async function detectRemoteHostPlatform(
  conn: SshConnection
): Promise<RemoteHostPlatform | null> {
  const unamePlatform = await detectUnamePlatform(conn)
  if (unamePlatform) {
    return getRemoteHostPlatform(unamePlatform)
  }
  const windowsPlatform = await detectWindowsPlatform(conn)
  return windowsPlatform ? getRemoteHostPlatform(windowsPlatform) : null
}

async function detectUnamePlatform(conn: SshConnection): Promise<RelayPlatform | null> {
  try {
    const output = await execCommand(conn, 'uname -sm')
    const parts = output.trim().split(/\s+/)
    if (parts.length < 2) {
      return null
    }
    return parseUnameToRelayPlatform(parts[0], parts[1])
  } catch {
    return null
  }
}

async function detectWindowsPlatform(conn: SshConnection): Promise<RelayPlatform | null> {
  try {
    const script = [
      '$arch = $env:PROCESSOR_ARCHITECTURE',
      'try { $runtimeArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); if ($runtimeArch) { $arch = $runtimeArch } } catch {}',
      'if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }',
      'Write-Output ("Windows " + $arch)'
    ].join('; ')
    const output = await execCommand(conn, powerShellCommand(script), { wrapCommand: false })
    const parts = output.trim().split(/\s+/)
    if (parts.length < 2 || parts[0].toLowerCase() !== 'windows') {
      return null
    }
    return parseUnameToRelayPlatform('Windows', parts[1])
  } catch {
    return null
  }
}
