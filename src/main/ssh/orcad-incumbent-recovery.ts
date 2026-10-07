/**
 * Putting a host back to the slot and state it had before an activation or rollback.
 *
 * Shared by the in-flight failure paths and by crash recovery, so both apply one rule: state
 * a launched slot may have changed is replaced only after that slot is proven exited, and only
 * when an operator accepts it — the slot exposed RPC, and with it stopped nothing on the host
 * can count the terminals it started, so the snapshot may no longer describe them.
 */
import { execOrcadStateMutation } from './orcad-state-mutation-exec'
import { orcadRemoteBaseDir } from './orcad-remote-windows-node'
import type { ServeReadiness } from '../server/serve-readiness'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { ORCAD_STATE_SNAPSHOT_DIR } from './orcad-activation-record'
import type { OrcadSnapshotVerdict } from './orcad-activation-transaction'
import {
  clearOrcadStateSnapshotMembersCommand,
  compareOrcadStateSnapshotCommand,
  orcadSnapshotIsUnchanged,
  parseOrcadSnapshotRestore,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { execOrcadRemote } from './orcad-remote-runtime-control'
import {
  ensureOrcadSlotServing,
  launchOrcadSlot,
  quiesceInterruptedOrcadSlot,
  type OrcadSlotIdentity,
  type OrcadSlotOptions
} from './orcad-recovery-slot'
import { joinRemotePath } from './ssh-remote-platform'
import { ORCAD_RECOVERY_CHANGED_STATE_CODE } from '../../shared/orcad-managed-runtime'

export type OrcadIncumbentRecoveryOptions = OrcadSlotOptions & {
  /** The operator accepted restoring the snapshot over state a launched build changed. */
  acceptChangedState?: boolean
}

export type OrcadIncumbentRecovery =
  | { outcome: 'restored'; readiness: ServeReadiness | null }
  | { outcome: 'refused'; verdict: 'live' | 'unverifiable'; code: string; reason: string }

export function orcadSnapshotPath(options: OrcadSlotOptions, dirName: string): string {
  return joinRemotePath(
    options.host,
    options.remoteHome,
    RELAY_REMOTE_DIR,
    ORCAD_STATE_SNAPSHOT_DIR,
    dirName
  )
}

/** Throws when a step cannot be verified; the caller keeps the fence. */
export async function recoverOrcadIncumbent(
  options: OrcadIncumbentRecoveryOptions,
  input: {
    transactionStartedAt: string
    launchedVersion: string | null
    incumbent: OrcadSlotIdentity | null
    restoreState: OrcadSnapshotVerdict | null
    /** The state the launched slot started from, when that is not `restoreState` (a rollback). */
    launchedFromState?: OrcadSnapshotVerdict | null
    /** This run itself proved both slots exited, so no fresh liveness probe is needed. */
    slotsProvenExited?: boolean
  }
): Promise<OrcadIncumbentRecovery> {
  const quiescence =
    input.slotsProvenExited || !input.restoreState
      ? 'exited'
      : await quiesceInterruptedOrcadSlot(options, input.launchedVersion, input.incumbent)
  // With no incumbent there is no older reader to protect; the record names nothing to serve.
  if (quiescence === 'exited' && input.restoreState && input.incumbent) {
    const decision = input.launchedVersion
      ? await decideChangedStateRestore(options, input.launchedFromState ?? input.restoreState)
      : 'restore'
    if (decision !== 'restore' && decision !== 'unchanged') {
      return decision
    }
    // A launched slot that left its starting state untouched still sits on a root to replace.
    if (decision === 'restore' || input.launchedFromState) {
      await restoreState(options, input.restoreState)
    }
  }
  if (!input.incumbent) {
    return { outcome: 'restored', readiness: null }
  }
  return {
    outcome: 'restored',
    readiness: input.slotsProvenExited
      ? await launchOrcadSlot(options, input.incumbent)
      : await ensureOrcadSlotServing(options, input.incumbent)
  }
}

async function decideChangedStateRestore(
  options: OrcadIncumbentRecoveryOptions,
  state: OrcadSnapshotVerdict
): Promise<'unchanged' | 'restore' | Extract<OrcadIncumbentRecovery, { outcome: 'refused' }>> {
  if (state.state === 'captured') {
    const snapshotDir = orcadSnapshotPath(options, state.dirName)
    // Read-only, so a lost answer is just "changed".
    const comparison = await execOrcadRemote(
      options,
      compareOrcadStateSnapshotCommand(
        options.host,
        options.userDataDir,
        snapshotDir,
        orcadRemoteBaseDir(options.host, options.remoteHome)
      )
    ).catch(() => '')
    if (orcadSnapshotIsUnchanged(comparison)) {
      return 'unchanged'
    }
  }
  if (options.acceptChangedState) {
    return 'restore'
  }
  const retained =
    state.state === 'captured' ? ` at ${orcadSnapshotPath(options, state.dirName)}` : ''
  return {
    outcome: 'refused',
    verdict: 'unverifiable',
    code: ORCAD_RECOVERY_CHANGED_STATE_CODE,
    reason:
      'The launched build is stopped, but it changed profile state (or the change could not be ' +
      'checked), so the previous build was not restarted against it and this host serves ' +
      'nothing. Recover to restore the prelaunch snapshot' +
      `${retained} and restart the previous build; terminals the launched build started keep ` +
      'running but drop out of the restored state.'
  }
}

async function restoreState(options: OrcadSlotOptions, state: OrcadSnapshotVerdict): Promise<void> {
  if (state.state === 'pending') {
    throw new Error('The interrupted transaction has no durable snapshot verdict.')
  }
  const command =
    state.state === 'captured'
      ? restoreOrcadStateSnapshotCommand(
          options.host,
          options.userDataDir,
          orcadSnapshotPath(options, state.dirName),
          orcadRemoteBaseDir(options.host, options.remoteHome)
        )
      : clearOrcadStateSnapshotMembersCommand(
          options.host,
          options.userDataDir,
          orcadRemoteBaseDir(options.host, options.remoteHome)
        )
  const restored = parseOrcadSnapshotRestore(await execOrcadStateMutation(options, command))
  if (restored !== 'restored') {
    throw new Error(`The prelaunch state could not be restored (${restored}).`)
  }
}
