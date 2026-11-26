import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'

export const PIPELINE_STORE_GROUPS = ['runs', 'templates', 'requests', 'decisions'] as const

export type PipelineStoreWorkerRequest = {
  id: number
  file: string
  group: (typeof PIPELINE_STORE_GROUPS)[number]
  op: string
  args: unknown[]
}
export type PipelineStoreWorkerResponse =
  | { id: number; ok: true; value: unknown; events: RuntimeClientEvent[] }
  | { id: number; ok: false; error: string; events: RuntimeClientEvent[] }
