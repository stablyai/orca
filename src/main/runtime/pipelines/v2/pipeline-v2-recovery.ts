import type { PipelineStore } from '../pipeline-store'
import { commandPipelineV2 } from './pipeline-v2-execution'

export function restorePipelineV2(store: PipelineStore): void {
  for (const run of store.pendingV2()) {
    const invocation = run.invocations.find((value) => value.id === run.activeInvocationId)
    if (invocation?.session?.kind !== 'checks' || run.state === 'reconciliation_required') {
      continue
    }
    if (!store.completedCheckEffect(`pipeline-v2:${invocation.id}`)) {
      commandPipelineV2(store, run.id, {
        kind: 'uncertain',
        reason: 'pipeline_check_process_outcome_unknown_after_restart'
      })
      continue
    }
    commandPipelineV2(store, run.id, {
      kind: invocation.state === 'submitted' ? 'settle' : 'interrupted',
      invocationId: invocation.id
    })
  }
}
