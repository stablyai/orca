import type { SshConnection } from './ssh-connection'
import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
import { parseUnameToRelayPlatform, type RelayPlatform } from './relay-protocol'
import { execCommand } from './ssh-relay-deploy-helpers'
import { getRemoteHostPlatform, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'

const PLATFORM_PROBE_MARKER = '__ORCA_REMOTE_PLATFORM__'

export async function detectRemoteHostPlatform(
  conn: SshConnection,
  options?: { signal?: AbortSignal }
): Promise<RemoteHostPlatform | null> {
  const unamePlatform = await detectUnamePlatform(conn, options?.signal)
  if (unamePlatform) {
    return getRemoteHostPlatform(unamePlatform)
  }
  const windowsPlatform = await detectWindowsPlatform(conn, options?.signal)
  return windowsPlatform ? getRemoteHostPlatform(windowsPlatform) : null
}

async function detectUnamePlatform(
  conn: SshConnection,
  signal?: AbortSignal
): Promise<RelayPlatform | null> {
  try {
    // Why: Remote startup output may omit its trailing newline and must not absorb the marker.
    const command = `printf '\\n%s ' '${PLATFORM_PROBE_MARKER}'; uname -sm`
    const output = signal
      ? await execCommand(conn, command, { signal })
      : await execCommand(conn, command)
    return parseRemotePlatformOutput(output)
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

async function detectWindowsPlatform(
  conn: SshConnection,
  signal?: AbortSignal
): Promise<RelayPlatform | null> {
  try {
    const script = [
      '$arch = $env:PROCESSOR_ARCHITECTURE',
      'try { $runtimeArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); if ($runtimeArch) { $arch = $runtimeArch } } catch {}',
      'if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }',
      // Why: Remote startup output may omit its trailing newline and must not absorb the marker.
      `Write-Output ("\`n${PLATFORM_PROBE_MARKER} Windows " + $arch)`
    ].join('; ')
    const output = await execCommand(conn, powerShellCommand(script), {
      wrapCommand: false,
      ...(signal ? { signal } : {})
    })
    return parseRemotePlatformOutput(output)
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

function parseRemotePlatformOutput(output: string): RelayPlatform | null {
  // Why: SSH startup noise can resemble valid probe output and select the wrong relay.
  for (const line of iterateProcessOutputLines(output)) {
    const parts = getProcessOutputFields(line, 3)
    if (parts.length < 3 || parts[0] !== PLATFORM_PROBE_MARKER) {
      continue
    }
    const platform = parseUnameToRelayPlatform(parts[1], parts[2])
    if (platform) {
      return platform
    }
  }
  return null
}
