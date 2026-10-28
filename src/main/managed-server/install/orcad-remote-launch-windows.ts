// Win32-OpenSSH kills session jobs; require native breakaway without WMI/PowerShell, then record PID plus creation time.
import {
  ORCAD_WINDOWS_BREAKAWAY_CONTRACT,
  parseWindowsBreakawayLaunchReport,
  WINDOWS_BREAKAWAY_ENV_FLAG,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG,
  WINDOWS_BREAKAWAY_STDERR_FLAG,
  WINDOWS_BREAKAWAY_STDERR_KEEP_PREVIOUS_FLAG,
  WINDOWS_BREAKAWAY_STDOUT_FLAG
} from '../../../shared/windows-breakaway-launch'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  orcadWindowsNodeCommandLine,
  orcadWindowsSlotOpCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import {
  ORCAD_WINDOWS_ENTRY_MARKER,
  ORCAD_WINDOWS_RUNTIME_MARKER
} from '../host-state/orcad-windows-host-script'
import {
  ORCAD_LOG_FILENAME,
  ORCAD_READINESS_FILENAME,
  ORCAD_WINDOWS_PROCESS_FILENAME
} from './orcad-remote-host-support'
import { orcadManagedLaunchEnv, type OrcadLaunchSpec } from './orcad-remote-launch'
import { ORCAD_WINDOWS_LAUNCH_REFUSED_CODE } from '../../orcad/orcad-host-unavailable'

export class OrcadWindowsLaunchRefusedError extends Error {
  readonly code = ORCAD_WINDOWS_LAUNCH_REFUSED_CODE
  constructor(reason: string) {
    super(
      `The Windows host refused to start orcad outside the SSH session (${reason}). orcad needs ` +
        'a job that allows breakaway and a slot with the process-tree launcher; it never falls ' +
        'back to WMI.'
    )
    this.name = 'OrcadWindowsLaunchRefusedError'
  }
}

/** Resolve pinned slot runtime and remove stale instance-stop intent before launch. */
export function windowsOrcadLaunchRuntimeCommand(
  host: RemoteHostPlatform,
  slotDir: string
): string {
  return orcadWindowsSlotOpCommand(host, slotDir, 'slot-runtime', [slotDir, 'clear-stop-request'])
}

export function readWindowsOrcadSlotRuntime(output: string): string {
  const runtime = readOrcadWindowsEncodedAnswer(output, ORCAD_WINDOWS_RUNTIME_MARKER)
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this orcad slot needs.')
  }
  return runtime
}

/** Older host scripts omit entry, implying the legacy single-file launcher. */
export function readWindowsOrcadSlotEntry(
  output: string,
  host: RemoteHostPlatform,
  slotDir: string
): string {
  return (
    readOrcadWindowsEncodedAnswer(output, ORCAD_WINDOWS_ENTRY_MARKER) ??
    joinRemotePath(host, slotDir, 'orcad.js')
  )
}

export function windowsOrcadLaunchCommand(
  host: RemoteHostPlatform,
  spec: OrcadLaunchSpec,
  slotRuntime: string,
  slotEntry = joinRemotePath(host, spec.remoteInstallDir, 'orcad.js')
): string {
  const dir = spec.remoteInstallDir
  return orcadWindowsNodeCommandLine(slotRuntime, [
    slotEntry,
    WINDOWS_BREAKAWAY_LAUNCH_FLAG,
    // CREATE_ALWAYS removes stale readiness before the launcher returns.
    WINDOWS_BREAKAWAY_STDOUT_FLAG,
    joinRemotePath(host, dir, ORCAD_READINESS_FILENAME),
    WINDOWS_BREAKAWAY_STDERR_FLAG,
    joinRemotePath(host, dir, ORCAD_LOG_FILENAME),
    // Preserve previous stderr for crash diagnosis across restart.
    WINDOWS_BREAKAWAY_STDERR_KEEP_PREVIOUS_FLAG,
    WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG,
    joinRemotePath(host, dir, ORCAD_WINDOWS_PROCESS_FILENAME),
    WINDOWS_BREAKAWAY_ENV_FLAG,
    `ORCA_VERSION=${spec.fullVersion}`,
    WINDOWS_BREAKAWAY_ENV_FLAG,
    `ORCA_USER_DATA=${spec.userDataDir}`,
    ...orcadManagedLaunchEnv(spec).flatMap(([name, value]) => [
      WINDOWS_BREAKAWAY_ENV_FLAG,
      `${name}=${value}`
    ]),
    ORCAD_WINDOWS_BREAKAWAY_CONTRACT.argsFlag,
    '--json',
    '--bind',
    spec.bindHost,
    '--port',
    String(spec.port)
  ])
}

/** Return launched PID or surface native-breakaway refusal/failure. */
export function readWindowsOrcadLaunchReport(output: string): number {
  const report = parseWindowsBreakawayLaunchReport(ORCAD_WINDOWS_BREAKAWAY_CONTRACT, output)
  if (report?.method === 'breakaway') {
    return report.pid
  }
  if (report?.method === 'unavailable') {
    throw new OrcadWindowsLaunchRefusedError(
      report.step ? `${report.reason} at ${report.step}` : report.reason
    )
  }
  const detail =
    report?.method === 'failed'
      ? `${report.reason}${report.step ? ` at ${report.step}` : ''} (code ${String(report.code ?? 0)})`
      : 'no launch report'
  throw new Error(`orcad's Windows launcher did not start the candidate: ${detail}.`)
}
