import * as z from 'zod'
import type { PipelineStorePort } from '../pipeline-store-port'
import type { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import {
  pipelineV2Id,
  pipelineV2Revision
} from '../../../../shared/pipelines/v2/pipeline-v2-values'

const query = z.strictObject({
  id: pipelineV2Id,
  projectId: pipelineV2Id,
  workspaceId: z.string().min(1).max(4096),
  instanceId: pipelineV2Id,
  cursor: pipelineV2Revision.default(0),
  limit: z.number().int().min(1).max(50).default(50)
})
export async function pipelineV2Events(store: PipelineStorePort, raw: unknown) {
  const input = query.parse(raw)
  const run = await store.getV2(input.id)
  if (
    input.projectId !== run.workspace.projectId ||
    input.workspaceId !== run.workspace.id ||
    input.instanceId !== run.workspace.instanceId
  ) {
    throw new Error('pipeline_workspace_instance_changed')
  }
  if (input.cursor > run.eventSequence) {
    throw new Error('pipeline_cursor_invalid')
  }
  return await store.eventsV2(input.id, input.cursor, input.limit)
}
export function publishPipelineV2Change(
  publish: ((event: RuntimeClientEvent) => void) | undefined,
  run: PipelineV2Run
): void {
  try {
    publish?.({
      type: 'pipelinesChanged',
      projectId: run.workspace.projectId,
      workspaceId: run.workspace.id,
      instanceId: run.workspace.instanceId,
      runId: run.id,
      revision: run.revision,
      sequence: run.eventSequence,
      ...(run.reason ? { reason: run.reason } : {})
    })
  } catch {
    console.error('[pipelines] progress notification failed after commit')
  }
}
