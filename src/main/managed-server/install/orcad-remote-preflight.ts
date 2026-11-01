import { randomUUID } from 'node:crypto'
import { ORCAD_NODE_RUNTIME_IDENTITY } from '../../../shared/orcad-node-runtime-identity'
import { ORCAD_NODE_RUNTIME_MARKER_FILENAME } from '../../../shared/orcad-artifacts'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseOrcadProfilePreflight,
  type OrcadProfilePreflightResponse
} from '../../../shared/orcad-profile-preflight'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import {
  orcadWindowsNodeCommandLine,
  orcadWindowsSlotOpCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import { readWindowsOrcadSlotEntry } from './orcad-remote-launch-windows'
import { ORCAD_WINDOWS_RUNTIME_MARKER } from '../host-state/orcad-windows-host-script'
import { orcadNodeSlotRuntimeCommand, selectOrcadSlotEntryCommand } from './orcad-remote-runtime'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'

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
  const output = await execCommand(options.conn, command, {
    signal: options.signal,
    timeoutMs: ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    wrapCommand: !isWindowsRemoteHost(options.host)
  })
  return parseOrcadProfilePreflight(output, nonce, ORCAD_NODE_RUNTIME_IDENTITY, options.fullVersion)
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
  const slotAnswer = await execCommand(
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
