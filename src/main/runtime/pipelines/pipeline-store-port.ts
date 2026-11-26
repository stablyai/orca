import type { PipelineStore } from './pipeline-store'
import type { PipelineV2Templates } from './v2/pipeline-v2-templates'
import type { PipelineV2OwnerRequests } from './v2/pipeline-v2-owner-requests'
import type { PipelineV2OwnerHistory } from './v2/pipeline-v2-owner-history'

export const PIPELINE_STORE_OPS = [
  'create',
  'get',
  'createV2',
  'getV2',
  'hasV2',
  'listV2',
  'pageV2',
  'pendingV2',
  'commandV2',
  'internalV2',
  'historyContext',
  'observeRawInput',
  'receiptV2',
  'requestRunV2',
  'eventsV2',
  'list',
  'reserveCreation',
  'creation',
  'creationSnapshot',
  'completeCreation',
  'reserveCreationV2',
  'creationV2',
  'creationSnapshotV2',
  'completeCreationV2',
  'pending',
  'command',
  'replay',
  'configureChecks',
  'configuredChecks',
  'context',
  'close',
  'claimEffect',
  'settleEffect',
  'completedCheckEffect',
  'launchReceiptV2'
] as const satisfies readonly (keyof PipelineStore)[]
export const PIPELINE_TEMPLATE_OPS = [
  'hasReceipt',
  'list',
  'receipt',
  'replaySave',
  'saveEdited',
  'validate',
  'deleteDraft',
  'getDraft',
  'saveDraft',
  'publish',
  'getVersion',
  'resolve',
  'setEnabled',
  'copyDraft'
] as const satisfies readonly (keyof PipelineV2Templates)[]
export const PIPELINE_REQUEST_OPS = [
  'get',
  'request',
  'list'
] as const satisfies readonly (keyof PipelineV2OwnerRequests)[]
export const PIPELINE_DECISION_OPS = [
  'forVisit',
  'artifact'
] as const satisfies readonly (keyof PipelineV2OwnerHistory)[]

type StoreMethods<T, K extends keyof T, Async extends boolean> = {
  [P in K]: T[P] extends (...args: infer A) => infer R
    ? (...args: A) => Async extends true ? Promise<R> : R | Promise<R>
    : never
}
type StorePort<Async extends boolean> = StoreMethods<
  PipelineStore,
  (typeof PIPELINE_STORE_OPS)[number],
  Async
> & {
  templatesV2: StoreMethods<PipelineV2Templates, (typeof PIPELINE_TEMPLATE_OPS)[number], Async>
  ownerRequestsV2: StoreMethods<
    PipelineV2OwnerRequests,
    (typeof PIPELINE_REQUEST_OPS)[number],
    Async
  >
  decisionsV2: StoreMethods<PipelineV2OwnerHistory, (typeof PIPELINE_DECISION_OPS)[number], Async>
}
export type PipelineStorePort = StorePort<false>
export type PipelineStoreRemote = StorePort<true>

export function callPipelineStoreMethod<T, K extends keyof T>(
  store: T,
  methods: readonly K[],
  op: string,
  args: readonly unknown[]
): unknown {
  const name = methods.find((method) => method === op)
  if (name === undefined) {
    throw new Error('pipeline_store_operation_invalid')
  }
  const method = store[name]
  if (typeof method !== 'function') {
    throw new Error('pipeline_store_operation_invalid')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the op is from the store's explicit method table and the worker receives the matching port method's arguments.
  const operation = method as (...parameters: never[]) => unknown
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the same method's structured-cloned arguments, without conversion or interpretation.
  return operation.apply(store, args as never[])
}
