import type { PipelineStore } from './pipeline-store'
import { commandPipelineV2 } from './v2/pipeline-v2-execution'

export function releasePipelineSetup(store: PipelineStore, id: string): void {
  if (store.hasV2(id)) {
    if (store.getV2(id).setupHold) {
      commandPipelineV2(store, id, { kind: 'setup_ready' })
    }
    return
  }
  const run = store.get(id)
  store.command(id, {
    requestId: `setup-ready:${id}:${run.revision}`,
    expectedRevision: run.revision,
    command: { kind: 'setup_ready' }
  })
}
export function failPipelineSetup(store: PipelineStore, id: string, reason: string): void {
  if (store.hasV2(id)) {
    commandPipelineV2(store, id, { kind: 'uncertain', reason })
    return
  }
  const run = store.get(id)
  store.command(id, {
    requestId: `setup-failed:${id}:${run.revision}`,
    expectedRevision: run.revision,
    command: { kind: 'uncertain', reason }
  })
}
