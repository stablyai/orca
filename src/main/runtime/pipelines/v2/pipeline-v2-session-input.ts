import type { PipelineStore } from '../pipeline-store'
import type { PipelineSessionBinding } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { commandPipelineV2 } from './pipeline-v2-execution'

export type PipelineRawInputReceipt = {
  receiptId: string
  accepted: boolean
  queryReply: boolean
  submitKeyOnly?: boolean
}
export function observePipelineV2RawInput(
  store: PipelineStore,
  binding: PipelineSessionBinding,
  input: PipelineRawInputReceipt
): void {
  if (!input.accepted || input.queryReply) {
    return
  }
  for (const run of store.pendingV2()) {
    const candidate = run.candidates.find((value) => value.id === run.pendingDecision?.candidateId)
    if (candidate?.sessionId === binding.sessionId) {
      const active = run.invocations.find((value) => value.id === run.activeInvocationId)
      if (
        input.submitKeyOnly &&
        active?.session?.sessionId === binding.sessionId &&
        (active.state === 'running' || active.state === 'submitted')
      ) {
        continue
      }
      commandPipelineV2(
        store,
        run.id,
        { kind: 'invalidate_candidate', sessionId: binding.sessionId, receiptId: input.receiptId },
        `raw:${run.id}:${input.receiptId}`
      )
    }
  }
}
