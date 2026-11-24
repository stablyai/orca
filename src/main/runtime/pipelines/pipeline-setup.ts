import type { PipelineStorePort } from './pipeline-store-port'
import { commandPipelineV2 } from './v2/pipeline-v2-execution'

export async function releasePipelineSetup(store: PipelineStorePort, id: string): Promise<void> {
  if (await store.hasV2(id)) {
    if ((await store.getV2(id)).setupHold) {
      await commandPipelineV2(store, id, { kind: 'setup_ready' })
    }
    return
  }
  const run = await store.get(id)
  await store.command(id, {
    requestId: `setup-ready:${id}:${run.revision}`,
    expectedRevision: run.revision,
    command: { kind: 'setup_ready' }
  })
}
export async function failPipelineSetup(
  store: PipelineStorePort,
  id: string,
  reason: string
): Promise<void> {
  if (await store.hasV2(id)) {
    await commandPipelineV2(store, id, { kind: 'uncertain', reason })
    return
  }
  const run = await store.get(id)
  await store.command(id, {
    requestId: `setup-failed:${id}:${run.revision}`,
    expectedRevision: run.revision,
    command: { kind: 'uncertain', reason }
  })
}
