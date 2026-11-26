import type { PipelineStore } from './pipeline-store'
import type { PipelineV2Command } from '../../../shared/pipelines/v2/pipeline-v2-mutations'

export function applyInternalPipelineV2(
  store: Pick<PipelineStore, 'getV2' | 'commandV2'>,
  id: string,
  command: PipelineV2Command,
  requestId?: string
) {
  const run = store.getV2(id)
  return store.commandV2(id, {
    requestId: requestId ?? `v2:${id}:${run.revision}:${command.kind}`,
    expectedRevision: run.revision,
    expectedInstanceId: run.workspace.instanceId,
    command
  })
}
