import type { SshConnection } from './ssh-connection'
import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
import { parseUnameToRelayPlatform, type RelayPlatform } from './relay-protocol'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { isSshSessionLimitError } from './ssh-session-limit-error'
import { getRemoteHostPlatform, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand } from './ssh-remote-powershell'

const PLATFORM_PROBE_MARKER = '__ORCA_REMOTE_PLATFORM__'
const MAX_UNAME_FIELD_CHARS = 64
const MAX_THROWN_OUTPUT_CHARS = 200
const MAX_LOGGED_OUTPUT_CHARS = 1000
const EXEC_TIMEOUT_MESSAGE = /timed out after \d+s$/u

type PlatformProbeOutcome =
  | { kind: 'detected'; platform: RelayPlatform }
  | { kind: 'unsupported'; uname: string }
  | { kind: 'unparsed'; output: string }
  | { kind: 'failed'; error: unknown }

export async function detectRemoteHostPlatform(
  conn: SshConnection,
  options?: { signal?: AbortSignal }
): Promise<RemoteHostPlatform | null> {
  const uname = await detectUnamePlatform(conn, options?.signal)
  if (uname.kind === 'detected') {
    return getRemoteHostPlatform(uname.platform)
  }
  if (uname.kind === 'failed' && shouldAbandonAfterUnameProbe(uname.error)) {
    throw uname.error
  }
  const windows = await detectWindowsPlatform(conn, options?.signal)
  if (windows.kind === 'detected') {
    return getRemoteHostPlatform(windows.platform)
  }
  // Why: only the PowerShell probe can settle a uname the parser cannot map
  // (Cygwin, say), so a refused or timed-out channel leaves it unsettled.
  const windowsProbeNeverRan = windows.kind === 'failed' && isTransportShapedError(windows.error)
  if ((uname.kind === 'unsupported' && !windowsProbeNeverRan) || windows.kind === 'unsupported') {
    const reported = uname.kind === 'unsupported' ? uname.uname : probeUname(windows)
    console.warn(`[ssh-relay] Remote reported an unsupported platform: ${reported}`)
    return null
  }
  console.warn(
    `[ssh-relay] Remote platform detection failed (uname probe: ${uname.kind}, PowerShell probe: ${windows.kind}). ` +
      `Remote output: "${summarizeProbeOutput(probeEvidence(uname) || probeEvidence(windows), MAX_LOGGED_OUTPUT_CHARS)}"`
  )
  throw undetectedPlatformError(uname, windows)
}

// Why: an unconfirmed close still holds the sshd session slot, so a second
// probe only burns another exec timeout before being refused too.
function shouldAbandonAfterUnameProbe(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    isUnconfirmedSshCommandTermination(error)
  )
}

/** Precedence: transport failure from either probe, then uname, then PowerShell. */
function undetectedPlatformError(
  uname: PlatformProbeOutcome,
  windows: PlatformProbeOutcome
): Error {
  for (const outcome of [uname, windows]) {
    if (outcome.kind === 'failed' && isTransportShapedError(outcome.error)) {
      return wrapProbeError(outcome.error)
    }
  }
  if (uname.kind === 'failed') {
    return wrapProbeError(uname.error)
  }
  if (uname.kind === 'unparsed') {
    return unrecognizedOutputError(uname.output)
  }
  if (windows.kind === 'failed') {
    return wrapProbeError(windows.error)
  }
  return unrecognizedOutputError(probeOutput(windows))
}

// Why: a refused or timed-out channel explains the failure better than the
// other probe's mundane non-zero exit (e.g. "sh: not found" on Windows).
function isTransportShapedError(error: unknown): boolean {
  return (
    isSshSessionLimitError(error) ||
    isUnconfirmedSshCommandTermination(error) ||
    (error instanceof Error && EXEC_TIMEOUT_MESSAGE.test(error.message))
  )
}

function wrapProbeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`Could not detect the remote platform: ${message}`, { cause: error })
}

function unrecognizedOutputError(output: string): Error {
  return new Error(
    `Remote platform probe returned no recognizable output. Remote output: "${summarizeProbeOutput(output, MAX_THROWN_OUTPUT_CHARS)}"`
  )
}

function probeOutput(outcome: PlatformProbeOutcome): string {
  return outcome.kind === 'unparsed' ? outcome.output : ''
}

function probeUname(outcome: PlatformProbeOutcome): string {
  return outcome.kind === 'unsupported' ? outcome.uname : ''
}

function probeEvidence(outcome: PlatformProbeOutcome): string {
  return probeOutput(outcome) || probeUname(outcome)
}

// Why: the marker is printed last, so the tail holds the evidence; collapsing
// CR/LF keeps a Windows banner from becoming a multi-line renderer message.
function summarizeProbeOutput(output: string, maxChars: number): string {
  const collapsed = output.replace(/\s+/gu, ' ').trim()
  return collapsed.length > maxChars ? `…${collapsed.slice(-maxChars)}` : collapsed
}

async function detectUnamePlatform(
  conn: SshConnection,
  signal?: AbortSignal
): Promise<PlatformProbeOutcome> {
  try {
    // Why: Remote startup output may omit its trailing newline and must not absorb the marker.
    const command = `printf '\\n%s ' '${PLATFORM_PROBE_MARKER}'; uname -sm`
    const output = signal
      ? await execCommand(conn, command, { signal })
      : await execCommand(conn, command)
    return parseRemotePlatformOutput(output)
  } catch (error) {
    signal?.throwIfAborted()
    return { kind: 'failed', error }
  }
}

async function detectWindowsPlatform(
  conn: SshConnection,
  signal?: AbortSignal
): Promise<PlatformProbeOutcome> {
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
  } catch (error) {
    signal?.throwIfAborted()
    return { kind: 'failed', error }
  }
}

function parseRemotePlatformOutput(output: string): PlatformProbeOutcome {
  let unsupportedUname = ''
  // Why: SSH startup noise can resemble valid probe output and select the wrong relay.
  for (const line of iterateProcessOutputLines(output)) {
    const parts = getProcessOutputFields(line, 3)
    if (parts.length < 3 || parts[0] !== PLATFORM_PROBE_MARKER) {
      continue
    }
    const platform = parseUnameToRelayPlatform(parts[1], parts[2])
    if (platform) {
      return { kind: 'detected', platform }
    }
    unsupportedUname = `${clampUnameField(parts[1])} ${clampUnameField(parts[2])}`
  }
  return unsupportedUname
    ? { kind: 'unsupported', uname: unsupportedUname }
    : { kind: 'unparsed', output }
}

// Why: a single field can be kilobytes — the scanner reads up to 4096 chars.
function clampUnameField(field: string): string {
  return field.length > MAX_UNAME_FIELD_CHARS ? `${field.slice(0, MAX_UNAME_FIELD_CHARS)}…` : field
}
