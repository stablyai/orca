/**
 * The PowerShell that starts a detached relay on a Windows SSH host.
 *
 * Win32-OpenSSH puts each session's shell in a job with KILL_ON_JOB_CLOSE, so a relay started
 * inside the session dies with it. The job allows breakaway, so `relay.js`'s one-shot launcher
 * mode starts the relay with CREATE_BREAKAWAY_FROM_JOB through the staged process-tree addon. That
 * works for a standard user; WMI Win32_Process.Create, the old route, is refused to a standard
 * user's network logon, so it runs only when the launcher is unavailable (a relay built without
 * the addon, or a job that refuses breakaway), and a refusal there is reported as one.
 */
import {
  RELAY_WINDOWS_BREAKAWAY_CONTRACT,
  WINDOWS_BREAKAWAY_EXIT_CODES,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  WINDOWS_BREAKAWAY_STDERR_FLAG,
  WINDOWS_BREAKAWAY_STDOUT_FLAG
} from '../../shared/windows-breakaway-launch'
import { commandWithNodePath } from './ssh-remote-commands'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellLiteral, powerShellNativeArg } from './ssh-remote-powershell'

/** Followed by the launch report as JSON, or `null` when the script printed none. */
export const WINDOWS_RELAY_LAUNCH_LOG_PREFIX = '[ssh-relay] Windows relay launch: '

/** In the launch error when neither route may start a process outside the session. */
export const WINDOWS_RELAY_LAUNCH_REFUSED_MARKER = 'ORCA_RELAY_LAUNCH_REFUSED'

export type WindowsRelayLaunchCommandOptions = {
  nodePath: string
  remoteDir: string
  sockPath: string
  endpointDir: string
  graceTime: number
  logFile: string
  errFile: string
  credentialFile: string
  ripgrepPath?: string
}

function relayDaemonArgs(opts: WindowsRelayLaunchCommandOptions): string[] {
  return [
    '--detached',
    '--grace-time',
    String(opts.graceTime),
    '--sock-path',
    opts.sockPath,
    '--credential-file',
    opts.credentialFile,
    '--endpoint-dir',
    opts.endpointDir,
    // Why: --log-file owns rotation; the stdout/stderr files still capture pre-JS boot/crash output.
    '--log-file',
    opts.logFile,
    ...(opts.ripgrepPath ? ['--ripgrep-path', opts.ripgrepPath] : [])
  ]
}

function wmiCommandLine(opts: WindowsRelayLaunchCommandOptions, relayScript: string): string {
  const quoted = (value: string): string => `"${value.replace(/"/g, '\\"')}"`
  const relayCommandLine = [
    quoted(opts.nodePath),
    quoted(relayScript),
    ...relayDaemonArgs(opts).map((arg) =>
      arg.startsWith('--') || arg === String(opts.graceTime) ? arg : quoted(arg)
    ),
    `1>${quoted(opts.logFile)}`,
    `2>${quoted(opts.errFile)}`
  ].join(' ')
  return `cmd.exe /d /s /c "${relayCommandLine}"`
}

export function windowsRelayLaunchCommand(
  hostPlatform: RemoteHostPlatform,
  opts: WindowsRelayLaunchCommandOptions
): string {
  const relayScript = joinRemotePath(hostPlatform, opts.remoteDir, 'relay.js')
  const launcherArgs = [
    WINDOWS_BREAKAWAY_LAUNCH_FLAG,
    WINDOWS_BREAKAWAY_STDOUT_FLAG,
    opts.logFile,
    WINDOWS_BREAKAWAY_STDERR_FLAG,
    opts.errFile,
    RELAY_WINDOWS_BREAKAWAY_CONTRACT.argsFlag,
    ...relayDaemonArgs(opts)
  ]
  const launcher = `& ${powerShellLiteral(opts.nodePath)} relay.js ${launcherArgs.map(powerShellNativeArg).join(' ')}`
  const refused = `${WINDOWS_RELAY_LAUNCH_REFUSED_MARKER}: this account cannot start a process that outlives the SSH session`
  const wmi = [
    'try {',
    `$orcaWmi = Invoke-CimMethod -ErrorAction Stop -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${powerShellLiteral(wmiCommandLine(opts, relayScript))}; CurrentDirectory = ${powerShellLiteral(opts.remoteDir)} }`,
    `} catch { throw "${refused}: breakaway launcher unavailable ($orcaLaunch) and WMI Win32_Process.Create denied ($($_.Exception.Message))" }`,
    `if ($orcaWmi.ReturnValue -ne 0) { throw "${refused}: breakaway launcher unavailable ($orcaLaunch) and Win32_Process.Create returned $($orcaWmi.ReturnValue)" }`,
    `'${RELAY_WINDOWS_BREAKAWAY_CONTRACT.reportMarker} {"method":"wmi"}'`
  ].join('; ')
  return commandWithNodePath(
    hostPlatform,
    opts.nodePath,
    opts.remoteDir,
    [
      `$orcaLaunch = (${launcher}) -join ' '`,
      '$orcaLaunchCode = $LASTEXITCODE',
      '$orcaLaunch',
      `if ($orcaLaunchCode -eq ${WINDOWS_BREAKAWAY_EXIT_CODES.unavailable}) { ${wmi} } ` +
        `elseif ($orcaLaunchCode -ne ${WINDOWS_BREAKAWAY_EXIT_CODES.launched}) { throw "Relay launcher exited $($orcaLaunchCode): $orcaLaunch" }`
    ].join('; ')
  )
}

/**
 * A launch refusal is a host policy, not a transient failure: name it rather than surface the
 * encoded command the exec error carries.
 */
export function classifyWindowsRelayLaunchError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error)
  const refusal = message
    .split(/\r?\n/u)
    .find((line) => line.includes(WINDOWS_RELAY_LAUNCH_REFUSED_MARKER))
  if (!refusal) {
    return error
  }
  const detail = refusal.slice(refusal.indexOf(WINDOWS_RELAY_LAUNCH_REFUSED_MARKER)).trim()
  return new Error(
    `The Windows host refused to start Orca's relay outside the SSH session. ${detail}`,
    { cause: error }
  )
}

/** Reaches a running Windows relay through its own bridge, as a reconnect or a census does. */
export function windowsRelayConnectCommand(
  hostPlatform: RemoteHostPlatform,
  nodePath: string,
  remoteDir: string,
  sockPath: string,
  credentialFile: string
): string {
  return commandWithNodePath(
    hostPlatform,
    nodePath,
    remoteDir,
    `& ${powerShellLiteral(nodePath)} relay.js --connect --sock-path ${powerShellLiteral(sockPath)} --credential-file ${powerShellLiteral(credentialFile)}`
  )
}
