import type { PipelineRuntime } from '../pipeline-runtime'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import {
  PipelineV2BoundSessionInput,
  PipelineV2BoundSessionAddress,
  type PipelineV2BoundSessionResult
} from '../../../../shared/pipelines/v2/pipeline-v2-session-contracts'
import { getPtyIdForPaneKey } from '../../../ipc/pty/pane/key-state'
import { discussPipelineV2 } from './pipeline-v2-discussion'
import { pipelineV2DeliveryReceipt, pipelineV2RefusalReceipt } from './pipeline-v2-delivery-receipt'
import type { PipelineV2InvocationReceipt } from '../../../../shared/pipelines/v2/pipeline-v2-results'

function discussionResult(receipt: PipelineV2InvocationReceipt): PipelineV2BoundSessionResult {
  return {
    handled: true,
    accepted: receipt.state === 'ready',
    receipt,
    ...(receipt.state === 'not_started' ? { rejected: 'pipeline_launch_refused' } : {})
  }
}

export async function discussPipelineV2BoundSession(
  service: Pick<PipelineRuntime, 'store' | 'controller' | 'assertWorkspace' | 'v2Ports' | 'wake'>,
  raw: unknown
): Promise<PipelineV2BoundSessionResult> {
  const address = PipelineV2BoundSessionAddress.parse(raw)
  const replay = await service.store.requestRunV2(address.requestId)
  if (replay) {
    const input = PipelineV2BoundSessionInput.parse(raw)
    const clientPayloadDigest = pipelineV2Fingerprint(input)
    await service.assertWorkspace(replay.workspace)
    const invocationId = `discussion:${pipelineV2Fingerprint({ id: replay.id, requestId: input.requestId })}`
    const invocation = replay.invocations.find((value) => value.id === invocationId)
    if (
      !invocation &&
      (await service.store.receiptV2(replay.id, input.requestId))?.kind === 'reserve'
    ) {
      return { handled: true, accepted: false, rejected: 'pipeline_budget_exhausted' }
    }
    if (!invocation || invocation.clientPayloadDigest !== clientPayloadDigest) {
      throw new Error('pipeline_request_conflict')
    }
    const refusal = await pipelineV2RefusalReceipt(service.store, invocation)
    if (refusal) {
      return discussionResult({ state: refusal.state, reason: refusal.reason })
    }
    const receipt = {
      state: !(await pipelineV2DeliveryReceipt(service.store, invocation))
        ? ('outcome_unknown' as const)
        : ('ready' as const),
      ...(invocation.dispatchId ? { dispatchId: invocation.dispatchId } : {}),
      ...(invocation.session ? { session: invocation.session } : {})
    }
    return discussionResult(receipt)
  }
  const run = (await service.store.pendingV2()).find((run) => {
    const candidate = run.candidates.find((value) => value.id === run.pendingDecision?.candidateId)
    const session = run.invocations.find((value) => value.id === candidate?.invocationId)?.session
    return (
      session &&
      (address.sessionId === session.sessionId ||
        Boolean(
          address.ptyId && session.paneKey && getPtyIdForPaneKey(session.paneKey) === address.ptyId
        ))
    )
  })
  if (!run?.pendingDecision) {
    return { handled: false, accepted: false }
  }
  try {
    const input = PipelineV2BoundSessionInput.parse(raw)
    const clientPayloadDigest = pipelineV2Fingerprint(input)
    if (input.hasAttachments) {
      throw new Error('pipeline_discussion_text_only')
    }
    const receipt = await discussPipelineV2(
      {
        store: service.store,
        controller: service.controller,
        assertWorkspace: (workspace) => service.assertWorkspace(workspace),
        sourceRevision: service.v2Ports.sourceRevision,
        reviewCommit: service.v2Ports.reviewCommit,
        wake: () => service.wake()
      },
      {
        id: run.id,
        requestId: input.requestId,
        expectedRevision: run.revision,
        expectedInstanceId: run.workspace.instanceId,
        pin: run.pendingDecision,
        message: input.message,
        clientPayloadDigest
      }
    )
    return discussionResult(receipt)
  } catch (error) {
    const reserved = await service.store.requestRunV2(address.requestId)
    if (reserved) {
      const invocationId = `discussion:${pipelineV2Fingerprint({ id: reserved.id, requestId: address.requestId })}`
      const invocation = reserved.invocations.find((value) => value.id === invocationId)
      const refusal = invocation && (await pipelineV2RefusalReceipt(service.store, invocation))
      if (refusal) {
        return discussionResult({ state: refusal.state, reason: refusal.reason })
      }
      if (
        !reserved.invocations.some((value) => value.id === invocationId) &&
        (await service.store.receiptV2(reserved.id, address.requestId))?.kind === 'reserve'
      ) {
        return { handled: true, accepted: false, rejected: 'pipeline_budget_exhausted' }
      }
      return { handled: true, accepted: false, receipt: { state: 'outcome_unknown' } }
    }
    const reason =
      error instanceof Error && /^pipeline_[a-z_]+$/.test(error.message)
        ? error.message
        : 'pipeline_discussion_invalid_input'
    return { handled: true, accepted: false, rejected: reason }
  }
}
