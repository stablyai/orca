import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import { FederationReconcileAttachmentParams } from '../../../../../../shared/rpc-contract/orchestration-federation-control-params'
import { inspectRemoteAttachment, requireHomeAttachment } from './federation-attachment-observation'

export const ORCHESTRATION_FEDERATION_RECONCILE_ATTACHMENT_METHODS = [
  defineMethod({
    name: 'orchestration.federationReconcileAttachment',
    params: FederationReconcileAttachmentParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      const attachment = requireHomeAttachment(
        runtime,
        params.dispatchId,
        authenticatedCallerFingerprint
      )
      if (attachment.state === 'abandoned' && attachment.capability_hash === null) {
        return reconcileReceipt(params.dispatchId, true)
      }
      const observation = await inspectRemoteAttachment(runtime, params.dispatchId)
      if (
        !observation.exact ||
        !observation.terminal ||
        observation.terminal.handle !== params.expectedTerminalHandle
      ) {
        throw new OrchestrationError(
          'worker_identity_changed',
          `Remote Dispatch ${params.dispatchId} no longer resolves to its recorded terminal.`
        )
      }
      if (observation.status !== 'live' && observation.status !== 'exited') {
        throw new OrchestrationError(
          'unverifiable',
          `Remote Dispatch ${params.dispatchId} is ${observation.status}; the attachment was not changed.`
        )
      }
      const recordedHandle = params.expectedTerminalHandle
      const reconciled = runtime.getOrchestrationDb().reconcileAbandonedRemoteAttachment({
        dispatchId: params.dispatchId,
        homePeerFingerprint: attachment.home_peer_fingerprint,
        expectedRuntimeEpoch: params.expectedRuntimeEpoch,
        currentRuntimeEpoch: runtime.getRuntimeId(),
        expectedTerminalHandle: recordedHandle,
        expectedPaneKey: params.expectedPaneKey,
        expectedProcessIncarnation: params.expectedProcessIncarnation,
        rereadObserved: () => {
          const verdict = runtime.getTerminalLivenessVerdict?.(recordedHandle) ?? null
          const status = verdict?.status
          return {
            paneKey: runtime.getTerminalPaneKey(recordedHandle),
            processIncarnation: runtime.getTerminalProcessIncarnation(recordedHandle),
            // A missing verdict is not live or exited. Only those two positive arms pass.
            unverifiable: status !== 'live' && status !== 'exited'
          }
        }
      })
      return reconcileReceipt(
        params.dispatchId,
        reconciled.disposition === 'already_reconciled'
      )
    }
  })
]

function reconcileReceipt(dispatchId: string, alreadyReconciled: boolean) {
  return {
    dispatchId,
    state: 'abandoned' as const,
    alreadyReconciled,
    processAction: 'none' as const
  }
}
