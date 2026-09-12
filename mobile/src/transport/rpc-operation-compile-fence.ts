import type { RpcClient } from './rpc-client'
import type { RpcMethodName, RpcParams, RpcSendParams } from './rpc-params-contract'
import { defineRpcOperation, runRpcOperation, startRpcOperation } from './rpc-operation'
import { rpcResultVariants } from './rpc-operation-result-reader'
import {
  workspaceListAtBarrier,
  workspaceListOrNull,
  workspaceRowsReader,
  worktreePsProbe,
  type WorkspaceRows
} from './rpc-operation-test-families'
import type {
  CapabilityProbeRpcDefinition,
  ObjectResultRpcDefinition,
  RequireResultRpcDefinition,
  RpcAcceptanceName,
  RpcCompatibleReader,
  RpcOperation
} from './rpc-operation-contract'

// Why this file exists: the descriptor's whole point is that a call site cannot pick the
// acceptance policy, the interpretation barrier, or the send-side params for itself. Every
// expect-error directive below is that claim as an assertion — tsc fails on a directive that
// stops catching an error, so `pnpm --dir mobile typecheck` is the gate. Nothing here runs and
// no app code imports it.

declare const client: RpcClient

// @ts-expect-error a variant reader combinator must have at least one reader
const _fenceEmptyVariantReaders = rpcResultVariants([])

export const fenceProbeWithReader: CapabilityProbeRpcDefinition<'worktree.ps', 'on-settle'> = {
  name: 'fence.probeWithReader',
  method: 'worktree.ps',
  acceptance: 'method-not-found-refusal',
  barrier: 'on-settle',
  // @ts-expect-error a refusal-code probe reads no payload, so it cannot carry a reader
  read: workspaceRowsReader
}

// @ts-expect-error 'require-result-or-throw' has no value to return without a reader
export const fenceDecodingWithoutReader: RequireResultRpcDefinition<
  'worktree.ps',
  'rows',
  WorkspaceRows,
  'on-settle'
> = {
  name: 'fence.decodingWithoutReader',
  method: 'worktree.ps',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle'
}

// @ts-expect-error the four policies in rpc-acceptance-policies.ts are the whole vocabulary
export const fenceInventedPolicy: RpcAcceptanceName = 'no-error-means-fine'

// A reader for a payload no acceptance policy here admits, i.e. one belonging to some other
// family's shape.
const fenceTextReader: RpcCompatibleReader<string, 'text', string> = (raw) => ({
  compatible: true,
  variant: 'text',
  value: raw,
  salvage: { droppedPaths: [], droppedCount: 0 }
})

export const fenceObjectPolicyWrongReader: ObjectResultRpcDefinition<
  'worktree.ps',
  'text',
  string,
  'on-settle'
> = {
  name: 'fence.objectPolicyWrongReader',
  method: 'worktree.ps',
  acceptance: 'object-result-or-null',
  barrier: 'on-settle',
  // @ts-expect-error the policy admits a non-null object, not the string this reader expects
  read: fenceTextReader
}

export const fenceDefineRejectsMismatch = defineRpcOperation({
  name: 'fence.defineRejectsMismatch',
  method: 'worktree.ps',
  // @ts-expect-error no overload of defineRpcOperation pairs a probe with a payload reader
  acceptance: 'method-not-found-refusal',
  barrier: 'on-settle',
  // @ts-expect-error ... and the reader it would need is exactly what the probe overload bans
  read: workspaceRowsReader
})

// @ts-expect-error only generated catalog method names are addressable
export const fenceUnknownMethod: RpcMethodName = 'worktree.nope'

// The send-side params type. z.output (what the handler receives) and z.input (what the
// coercing builders admit) are both wrong for a sender in opposite directions, so these pin
// the two failures a regression to either one would reintroduce.

// `query` and `limit` carry .default(), so a sender may leave them out. Under z.output both
// read as required and this line stops compiling.
export const fenceOmitsDefaultedField: RpcSendParams<'files.searchPaths'> = { worktree: 'w' }

export const fenceRejectsWrongFieldType: RpcSendParams<'files.searchPaths'> = {
  // @ts-expect-error z.input of a z.unknown().transform builder admits any value; this does not
  worktree: 42
}

// @ts-expect-error `worktree` has neither a default nor an optional marker
export const fenceKeepsRequiredField: RpcSendParams<'files.searchPaths'> = { query: 'x' }

// Catalog-wide: anything a handler could have been handed is something a sender may write.
// A method that ever resolves tighter than its parsed shape lands in this union.
declare const fenceTighterThanParsed: {
  [Method in RpcMethodName]: RpcParams<Method> extends RpcSendParams<Method> ? never : Method
}[RpcMethodName] & {}
export const fenceNoTighterMethod: never = fenceTighterThanParsed

// z.input collapses every coercing builder to `unknown`. Only plugins.panelAction may be
// unknown, because its schema is literally z.unknown().
declare const fenceUnknownParams: {
  [Method in RpcMethodName]: unknown extends RpcSendParams<Method> ? Method : never
}[RpcMethodName] & {}
export const fenceOnlyDeclaredUnknown: 'plugins.panelAction' = fenceUnknownParams

export async function fenceBarrierAndParams(): Promise<void> {
  await runRpcOperation(
    client,
    // @ts-expect-error this family interprets after all requests, so it has no on-settle run
    workspaceListAtBarrier,
    {}
  )
  startRpcOperation(
    client,
    // @ts-expect-error an on-settle family must not be parked behind someone else's barrier
    worktreePsProbe,
    {}
  )
  await runRpcOperation(
    client,
    workspaceListOrNull,
    // @ts-expect-error worktree.ps takes a numeric limit
    { limit: 'ten' }
  )
}

export async function fenceVerdictTypes(): Promise<void> {
  // @ts-expect-error the probe's policy yields a boolean, not the other family's rows
  const rows: WorkspaceRows = await runRpcOperation(client, worktreePsProbe, {})
  void rows
}

// @ts-expect-error the public descriptor also requires decoding, even without the factory
export const fenceManualWithoutReader: RpcOperation<
  'worktree.ps',
  'require-result-or-throw',
  'rows',
  WorkspaceRows,
  'on-settle'
> = {
  name: 'fence.manual',
  method: 'worktree.ps',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle'
}

// @ts-expect-error widening the policy cannot disconnect it from its required reader
export const fenceBroadWithoutReader: RpcOperation<
  'worktree.ps',
  RpcAcceptanceName,
  'rows',
  WorkspaceRows,
  'on-settle'
> = {
  name: 'fence.broad',
  method: 'worktree.ps',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: undefined
}

// @ts-expect-error object acceptance must decode, just like require-result acceptance
export const fenceObjectWithoutReader: RpcOperation<
  'worktree.ps',
  'object-result-or-null',
  'rows',
  WorkspaceRows,
  'on-settle'
> = {
  name: 'fence.object',
  method: 'worktree.ps',
  acceptance: 'object-result-or-null',
  barrier: 'on-settle'
}
