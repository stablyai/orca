import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import {
  parseOrcadStopOutcome,
  stopOrcadCommand,
  type OrcadStopOutcome
} from './orcad-remote-process-control'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { compareOrcadStateSnapshotCommand, orcadSnapshotIsUnchanged } from './orcad-state-snapshot'

export type OrcadOutgoingStopOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  nodePath: string
  signal?: AbortSignal
}

/** Stop the outgoing runtime and return its execution-host verdict. */
export async function stopOutgoingOrcad(
  options: OrcadOutgoingStopOptions,
  outgoingVersion: string
): Promise<OrcadStopOutcome> {
  const outgoingDir = computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    outgoingVersion
  )
  const output = await execCommand(
    options.conn,
    stopOrcadCommand(options.host, outgoingDir, { waitSeconds: 20, nodePath: options.nodePath }),
    {
      wrapCommand: options.host.commandDialect !== 'powershell',
      signal: options.signal
    }
  )
  return parseOrcadStopOutcome(output)
}

/** The caller must confirm candidate exit before inspecting its shared state. */
export async function rejectedOrcadStateRecoveryRefusal(
  options: OrcadOutgoingStopOptions & { userDataDir: string },
  incumbentVersion: string,
  snapshotDir: string | undefined
): Promise<string | undefined> {
  const unchanged = snapshotDir
    ? orcadSnapshotIsUnchanged(
        await execCommand(
          options.conn,
          compareOrcadStateSnapshotCommand(options.host, options.userDataDir, snapshotDir),
          { wrapCommand: options.host.commandDialect !== 'powershell', signal: options.signal }
        ).catch(() => '')
      )
    : false
  if (unchanged) {
    return undefined
  }
  // RPC was already exposed; a prelaunch census cannot authorize discarding candidate writes.
  const retainedSnapshot = snapshotDir ? ` at ${snapshotDir}.` : ', which is unavailable.'
  return (
    'The candidate is stopped, but profile state changed or could not be verified. ' +
    `orcad ${incumbentVersion} was not restarted against potentially incompatible state. ` +
    'Current state and daemon terminals are preserved; recovery requires a fresh host ' +
    `terminal census before restoring the prelaunch snapshot${retainedSnapshot}`
  )
}
