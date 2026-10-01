/**
 * Putting a host back to the slot and state it had before an activation or rollback.
 *
 * Shared by the in-flight failure paths and by crash recovery, so both apply one rule: state
 * a launched slot may have changed is replaced only after that slot is proven exited, and only
 * when the change provably carries no terminals — the slot exposed RPC, so a pre-launch census
 * cannot vouch for it.
 */
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

export type OrcadIncumbentRecoveryOptions = OrcadSlotOptions & {
  /**
   * Terminals started on the host since `since`, from a census taken now. Absent when no fresh
   * census is available; `null` when the daemon did not answer. Both keep changed state.
   */
  terminalsStartedSince?: (since: string) => Promise<number | null>
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
      ? await decideChangedStateRestore(options, input.transactionStartedAt, input.restoreState)
      : 'restore'
    if (decision !== 'restore' && decision !== 'unchanged') {
      return decision
    }
    if (decision === 'restore') {
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
  since: string,
  state: OrcadSnapshotVerdict
): Promise<'unchanged' | 'restore' | Extract<OrcadIncumbentRecovery, { outcome: 'refused' }>> {
  if (state.state === 'captured') {
    const snapshotDir = orcadSnapshotPath(options, state.dirName)
    // Read-only, so a lost answer is just "changed".
    const comparison = await execOrcadRemote(
      options,
      compareOrcadStateSnapshotCommand(options.host, options.userDataDir, snapshotDir)
    ).catch(() => '')
    if (orcadSnapshotIsUnchanged(comparison)) {
      return 'unchanged'
    }
  }
  const started = options.terminalsStartedSince
    ? await options.terminalsStartedSince(since)
    : undefined
  if (started === 0) {
    return 'restore'
  }
  const retained =
    state.state === 'captured' ? ` at ${orcadSnapshotPath(options, state.dirName)}` : ''
  return started === undefined || started === null
    ? {
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_recovery_census_required',
        reason:
          'The launched build is stopped, but profile state changed or could not be verified, ' +
          'so the previous build was not restarted against it. Current state and daemon ' +
          'terminals are preserved; recovery requires a fresh host terminal census before ' +
          `restoring the prelaunch snapshot${retained}.`
      }
    : {
        outcome: 'refused',
        verdict: 'live',
        code: 'orcad_recovery_orphans_live_terminals',
        reason:
          `${started} terminal${started === 1 ? '' : 's'} started after the interrupted ` +
          'change, and the prelaunch snapshot does not describe them. Restoring it would ' +
          `orphan running work; state is preserved${retained}.`
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
          orcadSnapshotPath(options, state.dirName)
        )
      : clearOrcadStateSnapshotMembersCommand(options.host, options.userDataDir)
  const restored = parseOrcadSnapshotRestore(await execOrcadRemote(options, command))
  if (restored !== 'restored') {
    throw new Error(`The prelaunch state could not be restored (${restored}).`)
  }
}
