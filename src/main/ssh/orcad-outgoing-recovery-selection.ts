import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { isPtyOwnershipTransferMutationEnabled } from '../../shared/pty-ownership-transfer-release-gate'
import type {
  OrcadOutgoingRecoveryCandidate,
  OrcadOutgoingRecoveryResult
} from '../../shared/orcad-outgoing-recovery'
import {
  OrcadOutgoingCaptureStore,
  parseOrcadOutgoingSourceBinding
} from './orcad-outgoing-capture-store'
import { recoverOutgoingOrcadCapture } from './orcad-outgoing-capture-recovery'
import { OrcadOutgoingPreparationStore } from './orcad-outgoing-preparation-store'
import { recoverOutgoingOrcadPreparation } from './orcad-outgoing-terminal-preparation'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'

export type OrcadOutgoingRecoveryRuntime = Parameters<
  typeof recoverOutgoingOrcadPreparation
>[1]['runtime']

export function listOutgoingOrcadRecoveryCandidates(
  userDataPath: string,
  selector: string,
  includePreparations = false
): OrcadOutgoingRecoveryCandidate[] {
  const environment = resolveEnvironment(userDataPath, selector)
  const captures = new OrcadOutgoingCaptureStore(userDataPath).list()
  const pending = includePreparations
    ? new OrcadOutgoingPreparationStore(userDataPath).list().filter((preparation) => {
        const captured = captures.find(
          (entry) => entry.identity.bridgeId === preparation.identity.bridgeId
        )
        if (!captured) {
          return true
        }
        if (
          serializeOrcadMigrationValue(parseOrcadOutgoingSourceBinding(captured)) !==
          serializeOrcadMigrationValue(parseOrcadOutgoingSourceBinding(preparation))
        ) {
          throw new Error('orcad_outgoing_preparation_evidence_changed')
        }
        return false
      })
    : []
  return [...captures, ...pending]
    .filter((entry) => entry.destinationEnvironmentId === environment.id)
    .map((entry) => ({
      ...('kind' in entry ? { stage: 'preparation' as const } : {}),
      bridgeId: entry.identity.bridgeId,
      terminalId: entry.identity.terminalId,
      incarnationId: entry.identity.incarnationId,
      destinationEnvironmentId: entry.destinationEnvironmentId,
      destinationRuntimeId: entry.identity.destinationRuntimeId,
      sourceSshTargetId: entry.sourceSshTargetId,
      sourceSshTargetGeneration: entry.sourceSshTargetGeneration
    }))
}

export async function recoverSelectedOutgoingOrcadCapture(
  userDataPath: string,
  args: {
    selector: string
    bridgeId: string
    signal: AbortSignal
    stage?: 'capture' | 'preparation'
    runtime?: OrcadOutgoingRecoveryRuntime
  }
): Promise<OrcadOutgoingRecoveryResult> {
  if (!isPtyOwnershipTransferMutationEnabled()) {
    throw new Error('pty_ownership_transfer_mutation_disabled')
  }
  args.signal.throwIfAborted()
  const environment = resolveEnvironment(userDataPath, args.selector)
  const store =
    args.stage === 'preparation'
      ? new OrcadOutgoingPreparationStore(userDataPath)
      : new OrcadOutgoingCaptureStore(userDataPath)
  const saved = store
    .list()
    .find(
      (entry) =>
        entry.identity.bridgeId === args.bridgeId &&
        entry.destinationEnvironmentId === environment.id
    )
  if (!saved) {
    throw new Error(
      args.stage === 'preparation'
        ? 'orcad_outgoing_preparation_missing'
        : 'orcad_outgoing_capture_missing'
    )
  }
  if (saved.identity.destinationRuntimeId !== environment.runtimeId) {
    throw new Error('orcad_outgoing_capture_destination_changed')
  }
  if (args.stage === 'preparation' && !args.runtime) {
    throw new Error('orcad_outgoing_preparation_runtime_unavailable')
  }
  const result =
    args.stage === 'preparation'
      ? await recoverOutgoingOrcadPreparation(userDataPath, {
          identity: saved.identity,
          signal: args.signal,
          runtime: args.runtime!
        })
      : await recoverOutgoingOrcadCapture(userDataPath, {
          identity: saved.identity,
          signal: args.signal
        })
  return { bridgeId: saved.identity.bridgeId, outcome: result.outcome }
}
