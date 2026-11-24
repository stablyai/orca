import type { PipelineStorePort } from '../pipeline-store-port'
import { commandPipelineV2 } from './pipeline-v2-execution'

export async function restorePipelineV2(store: PipelineStorePort): Promise<void> {
  for (const run of await store.pendingV2()) {
    const invocation = run.invocations.find((value) => value.id === run.activeInvocationId)
    if (invocation?.session?.kind !== 'checks' || run.state === 'reconciliation_required') {
      continue
    }
    if (!(await store.completedCheckEffect(`pipeline-v2:${invocation.id}`))) {
      await commandPipelineV2(store, run.id, {
        kind: 'uncertain',
        reason: 'pipeline_check_process_outcome_unknown_after_restart'
      })
      continue
    }
    await commandPipelineV2(store, run.id, {
      kind: invocation.state === 'submitted' ? 'settle' : 'interrupted',
      invocationId: invocation.id
    })
  }
}
