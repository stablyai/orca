/**
 * Waiting for a launched orcad's readiness line on the host, not across SSH.
 *
 * The client used to re-read the readiness file every 500 ms, one exec each, for up to three
 * minutes. A burst of short-lived processes under sshd is itself an EDR signal on Windows
 * (docs/reference/windows-edr-posture.md). One exec now waits host-side for a complete line, an
 * oversized file, or its own bounded deadline.
 */
import { shellEscape } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  ORCAD_READINESS_FILENAME,
  ORCAD_READINESS_MAX_BYTES,
  parseOrcadReadinessOutput,
  readOrcadReadinessCommand,
  type OrcadReadinessParse
} from './orcad-remote-launch'
import {
  orcadWindowsBaseDir,
  orcadWindowsHostOpCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import { ORCAD_WINDOWS_READINESS_MARKER } from './orcad-windows-host-script'

/** Under the 30 s exec timeout, so one wait never reads as an unanswered host. */
export const ORCAD_READINESS_WAIT_MAX_SECONDS = 20

/** Settles on a newline (a finished line) or more than the cap; both are final for the parser. */
function posixReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const file = shellEscape(joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME))
  const read = `head -c ${ORCAD_READINESS_MAX_BYTES + 1} ${file} 2>/dev/null`
  return [
    // Fractional sleep is not POSIX; probe it once so the deadline stays in seconds either way.
    'if sleep 0.25 2>/dev/null; then orcad_readiness_wait_step=0.25; orcad_readiness_wait_per=4;',
    'else orcad_readiness_wait_step=1; orcad_readiness_wait_per=1; fi;',
    `orcad_readiness_wait_left=$((${waitSeconds} * orcad_readiness_wait_per));`,
    'while [ "$orcad_readiness_wait_left" -gt 0 ]; do',
    `[ "$(${read} | wc -l)" -gt 0 ] && break;`,
    `[ "$(${read} | wc -c)" -gt ${ORCAD_READINESS_MAX_BYTES} ] && break;`,
    'sleep "$orcad_readiness_wait_step";',
    'orcad_readiness_wait_left=$((orcad_readiness_wait_left - 1)); done;',
    `${read} || true`
  ].join(' ')
}

export function orcadReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const seconds = Math.max(0, Math.min(ORCAD_READINESS_WAIT_MAX_SECONDS, Math.ceil(waitSeconds)))
  if (!isWindowsRemoteHost(host)) {
    return posixReadinessWaitCommand(host, remoteInstallDir, seconds)
  }
  return orcadWindowsHostOpCommand(
    host,
    orcadWindowsBaseDir(host, remoteInstallDir),
    'readiness-wait',
    [
      joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME),
      String(ORCAD_READINESS_MAX_BYTES),
      String(seconds)
    ]
  )
}

/** What the readiness file held when the host stopped waiting; `pending` if still unfinished. */
export function parseOrcadReadinessWaitOutput(
  host: RemoteHostPlatform,
  output: string
): OrcadReadinessParse {
  return parseOrcadReadinessOutput(
    isWindowsRemoteHost(host)
      ? (readOrcadWindowsEncodedAnswer(output, ORCAD_WINDOWS_READINESS_MARKER) ?? '')
      : output
  )
}

/** Reads the readiness line as it stands; parse with `parseOrcadReadinessWaitOutput`. */
export function readOrcadReadinessNowCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  // Why: Windows has no `head`; its host script's wait op with no wait reads the same bytes.
  return isWindowsRemoteHost(host)
    ? orcadReadinessWaitCommand(host, remoteInstallDir, 0)
    : readOrcadReadinessCommand(host, remoteInstallDir)
}
