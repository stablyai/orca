import { randomUUID } from 'node:crypto'
import { ORCAD_NODE_RUNTIME_IDENTITY } from '../../shared/orcad-node-runtime-identity'
import { ORCAD_NODE_RUNTIME_MARKER_FILENAME } from '../../shared/orcad-artifacts'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseOrcadProfilePreflight
} from '../../shared/orcad-profile-preflight'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import {
  orcadWindowsBaseDir,
  orcadWindowsHostOpCommand,
  orcadWindowsNodeCommandLine,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import { readWindowsOrcadSlotEntry } from './orcad-remote-launch-windows'
import { ORCAD_WINDOWS_RUNTIME_MARKER } from './orcad-windows-host-script'
import { orcadNodeSlotRuntimeCommand, selectOrcadSlotEntryCommand } from './orcad-remote-runtime'
import { execCommand } from './ssh-relay-deploy-helpers'
import { shellEscape } from './ssh-connection-utils'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'

export function orcadProfilePreflightCommand(
  host: RemoteHostPlatform,
  directory: string,
  nonce: string
): string {
  assertPosixOrcadHost(host)
  // Why no host-Node fallback: a candidate this client installed is always a Node slot.
  const marker = shellEscape(joinRemotePath(host, directory, ORCAD_NODE_RUNTIME_MARKER_FILENAME))
  const launch = [
    'ORCA_BACKGROUND_LAUNCH=1',
    '"$orcad_runtime"',
    '"$orcad_entry"',
    ORCAD_PROFILE_PREFLIGHT_FLAG,
    shellEscape(nonce)
  ].join(' ')
  return `[ -e ${marker} ] || exit 78; ${orcadNodeSlotRuntimeCommand(host, directory)}${selectOrcadSlotEntryCommand(host, directory)}; ${launch}`
}

/** Failure leaves the incumbent and its data untouched, including an unconfirmed SSH exit. */
export async function preflightInstalledOrcad(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteInstallDir: string
  fullVersion: string
  signal?: AbortSignal
}): Promise<void> {
  const nonce = randomUUID()
  const command = isWindowsRemoteHost(options.host)
    ? await windowsOrcadProfilePreflightCommand(options, nonce)
    : orcadProfilePreflightCommand(options.host, options.remoteInstallDir, nonce)
  const output = await execCommand(options.conn, command, {
    signal: options.signal,
    timeoutMs: ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    wrapCommand: !isWindowsRemoteHost(options.host)
  })
  parseOrcadProfilePreflight(output, nonce, ORCAD_NODE_RUNTIME_IDENTITY, options.fullVersion)
}

/**
 * Windows: resolve the slot's node.exe, then run its selected entry with plain argv. No
 * ORCA_BACKGROUND_LAUNCH here: orcad opens no window, and argv cannot set environment.
 */
async function windowsOrcadProfilePreflightCommand(
  options: {
    conn: SshConnection
    host: RemoteHostPlatform
    remoteInstallDir: string
    signal?: AbortSignal
  },
  nonce: string
): Promise<string> {
  const { host, remoteInstallDir } = options
  const slotAnswer = await execCommand(
    options.conn,
    orcadWindowsHostOpCommand(host, orcadWindowsBaseDir(host, remoteInstallDir), 'slot-runtime', [
      remoteInstallDir
    ]),
    { signal: options.signal, wrapCommand: false }
  )
  const runtime = readOrcadWindowsEncodedAnswer(slotAnswer, ORCAD_WINDOWS_RUNTIME_MARKER)
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this orcad slot needs.')
  }
  return orcadWindowsNodeCommandLine(runtime, [
    readWindowsOrcadSlotEntry(slotAnswer, host, remoteInstallDir),
    ORCAD_PROFILE_PREFLIGHT_FLAG,
    nonce
  ])
}
