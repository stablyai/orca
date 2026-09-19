/**
 * Stopping a running orcad on the host without taking its terminals with it.
 *
 * Managed lifecycle writes a slot-local request that the real orcad process consumes. It never
 * signals the PID file: after PID reuse, that could terminate an unrelated user process.
 */
import { shellEscape } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  assertPosixOrcadHost as assertPosixHost,
  ORCAD_PID_FILENAME,
  posixProcessAliveShellFunction
} from './orcad-remote-host-support'
import { ORCAD_STOP_REQUEST_FILENAME } from '../../shared/orcad-stop-request'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

/**
 * Request graceful shutdown from the version dir and wait for its recorded process to go.
 */
export function stopOrcadCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  options: { waitSeconds: number }
): string {
  if (isWindowsRemoteHost(host)) {
    return windowsStopOrcadCommand(host, remoteInstallDir, options)
  }
  assertPosixHost(host)
  const pidFile = shellEscape(joinRemotePath(host, remoteInstallDir, ORCAD_PID_FILENAME))
  const request = shellEscape(joinRemotePath(host, remoteInstallDir, ORCAD_STOP_REQUEST_FILENAME))
  return [
    posixProcessAliveShellFunction(),
    `pid=$(cat ${pidFile} 2>/dev/null);`,
    'case "$pid" in "" | *[!0-9]* ) echo NO_PID; exit 0;; esac;',
    'orcad_alive "$pid" || { echo ALREADY_EXITED; exit 0; };',
    `umask 077; printf '%s\n' "$$.$(date +%s)" > ${request} || { echo SIGNAL_FAILED; exit 0; };`,
    `i=0; while [ "$i" -lt ${options.waitSeconds} ]; do`,
    'orcad_alive "$pid" || { echo STOPPED; exit 0; };',
    'sleep 1; i=$((i + 1)); done;',
    'echo STILL_RUNNING'
  ].join(' ')
}

function windowsStopOrcadCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  options: { waitSeconds: number }
): string {
  const pidFile = joinRemotePath(host, remoteInstallDir, ORCAD_PID_FILENAME)
  const request = joinRemotePath(host, remoteInstallDir, ORCAD_STOP_REQUEST_FILENAME)
  const attempts = Math.max(1, options.waitSeconds * 4)
  return powerShellCommand(
    [
      `$pidText = if (Test-Path -LiteralPath ${powerShellLiteral(pidFile)} -PathType Leaf) { ` +
        `[IO.File]::ReadAllText(${powerShellLiteral(pidFile)}).Trim() } else { '' }`,
      `[int]$orcadPid = 0`,
      `if (-not [int]::TryParse($pidText, [ref]$orcadPid) -or $orcadPid -le 0) { Write-Output 'NO_PID'; exit 0 }`,
      `if ($null -eq (Get-Process -Id $orcadPid -ErrorAction SilentlyContinue)) { Write-Output 'ALREADY_EXITED'; exit 0 }`,
      `try { [IO.File]::WriteAllText(${powerShellLiteral(request)}, [guid]::NewGuid().ToString('N')) } catch { Write-Output 'SIGNAL_FAILED'; exit 0 }`,
      `for ($i = 0; $i -lt ${attempts}; $i += 1) { ` +
        `if ($null -eq (Get-Process -Id $orcadPid -ErrorAction SilentlyContinue)) { Write-Output 'STOPPED'; exit 0 }; ` +
        `Start-Sleep -Milliseconds 250 }`,
      `Write-Output 'STILL_RUNNING'`
    ].join('; ')
  )
}

export type OrcadStopOutcome =
  | 'stopped'
  | 'already-exited'
  | 'no-pid'
  | 'still-running'
  | 'signal-failed'
  | 'unknown'

export function parseOrcadStopOutcome(output: string): OrcadStopOutcome {
  switch (output.trim().split('\n').pop()?.trim() ?? '') {
    case 'STOPPED':
      return 'stopped'
    case 'ALREADY_EXITED':
      return 'already-exited'
    case 'NO_PID':
      return 'no-pid'
    case 'STILL_RUNNING':
      return 'still-running'
    case 'SIGNAL_FAILED':
      return 'signal-failed'
    default:
      return 'unknown'
  }
}

/** True when the port is free and a successor may bind. */
export function orcadStopFreedTheHost(outcome: OrcadStopOutcome): boolean {
  return outcome === 'stopped' || outcome === 'already-exited'
}
