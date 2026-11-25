import { randomUUID } from 'node:crypto'
import { ORCAD_NODE_RUNTIME_IDENTITY } from '../../../shared/remote-runtime/orcad-distribution/orcad-node-runtime-identity'
import { ORCAD_NODE_RUNTIME_MARKER_FILENAME } from '../../../shared/remote-runtime/orcad-distribution/orcad-artifacts'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseOrcadProfilePreflight,
  type OrcadProfilePreflightResponse
} from '../../../shared/remote-runtime/orcad-distribution/orcad-profile-preflight'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import {
  orcadWindowsNodeCommandLine,
  orcadWindowsSlotOpCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import { readWindowsOrcadSlotEntry } from './orcad-remote-launch-windows'
import { ORCAD_WINDOWS_RUNTIME_MARKER } from '../host-state/orcad-windows-host-script'
import { orcadNodeSlotRuntimeCommand, selectOrcadSlotEntryCommand } from './orcad-remote-runtime'
import { execCommand, isSshCommandExitError } from '../../ssh/remote-exec/remote-exec-command'
import { SYSTEM_SSH_TRANSPORT_EXIT_CODE } from '../../ssh/system-transport/system-ssh-operation-lifecycle'
import { errorMessage } from '../../../shared/errors/error-message'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/remote-host/ssh-remote-platform'
import type { OrcadHostTransport } from './orcad-host-transport'

/** The preflight timed out or lost its channel before the host answered, so it proves nothing about the host. */
export class OrcadPreflightUnansweredError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause })
    this.name = 'OrcadPreflightUnansweredError'
  }
}

export function orcadProfilePreflightCommand(
  host: RemoteHostPlatform,
  directory: string,
  nonce: string,
  probeDaemonsUnder?: string
): string {
  assertPosixOrcadHost(host)
  // New candidates always use pinned Node; host Node fallback could mask an incomplete slot.
  const marker = quotePosixShell(
    joinRemotePath(host, directory, ORCAD_NODE_RUNTIME_MARKER_FILENAME)
  )
  const launch = [
    'ORCA_BACKGROUND_LAUNCH=1',
    '"$orcad_runtime"',
    '"$orcad_entry"',
    ORCAD_PROFILE_PREFLIGHT_FLAG,
    quotePosixShell(nonce),
    ...(probeDaemonsUnder === undefined ? [] : [quotePosixShell(probeDaemonsUnder)])
  ].join(' ')
  return `[ -e ${marker} ] || exit 78; ${orcadNodeSlotRuntimeCommand(host, directory)}${selectOrcadSlotEntryCommand(host, directory)}; ${launch}`
}

/** Qualify the candidate; given the served data root, it also names the daemon generations alive there. */
export async function preflightInstalledOrcad(options: {
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  remoteInstallDir: string
  probeDaemonsUnder?: string
  fullVersion: string
  signal?: AbortSignal
}): Promise<OrcadProfilePreflightResponse> {
  const nonce = randomUUID()
  const command = isWindowsRemoteHost(options.host)
    ? await windowsOrcadProfilePreflightCommand(options, nonce)
    : orcadProfilePreflightCommand(
        options.host,
        options.remoteInstallDir,
        nonce,
        options.probeDaemonsUnder
      )
  const output = await execPreflightCommand(options.conn, command, {
    signal: options.signal,
    timeoutMs: ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    wrapCommand: !isWindowsRemoteHost(options.host)
  })
  return parseOrcadProfilePreflight(output, nonce, ORCAD_NODE_RUNTIME_IDENTITY, options.fullVersion)
}

async function execPreflightCommand(
  conn: OrcadHostTransport,
  command: string,
  options: NonNullable<Parameters<typeof execCommand>[2]>
): Promise<string> {
  const systemSsh = conn.usesSystemSshTransport?.() === true
  try {
    return await execCommand(conn, command, options)
  } catch (error) {
    // Only the remote command's own exit is the host's answer; OpenSSH exits 255 for itself.
    const hostExited =
      isSshCommandExitError(error) &&
      !(systemSsh && error.exitCode === SYSTEM_SSH_TRANSPORT_EXIT_CODE)
    if (hostExited || options.signal?.aborted) {
      throw error
    }
    throw new OrcadPreflightUnansweredError(error)
  }
}

// Windows uses plain argv; orcad opens no window and needs no background-launch environment.
async function windowsOrcadProfilePreflightCommand(
  options: {
    conn: OrcadHostTransport
    host: RemoteHostPlatform
    remoteInstallDir: string
    probeDaemonsUnder?: string
    signal?: AbortSignal
  },
  nonce: string
): Promise<string> {
  const { host, remoteInstallDir } = options
  const slotAnswer = await execPreflightCommand(
    options.conn,
    orcadWindowsSlotOpCommand(host, remoteInstallDir, 'slot-runtime', [remoteInstallDir]),
    { signal: options.signal, wrapCommand: false }
  )
  const runtime = readOrcadWindowsEncodedAnswer(slotAnswer, ORCAD_WINDOWS_RUNTIME_MARKER)
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this orcad slot needs.')
  }
  return orcadWindowsNodeCommandLine(runtime, [
    readWindowsOrcadSlotEntry(slotAnswer, host, remoteInstallDir),
    ORCAD_PROFILE_PREFLIGHT_FLAG,
    nonce,
    ...(options.probeDaemonsUnder === undefined ? [] : [options.probeDaemonsUnder])
  ])
}
