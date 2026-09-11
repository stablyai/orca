import { z } from 'zod'
import type { RpcResponse } from './types'
import type { RpcCompatibleReader } from './rpc-operation-contract'
import { rpcResultVariant, rpcResultVariants } from './rpc-operation-result-reader'
import { defineRpcOperation } from './rpc-operation'

// Operation families used by the rpc-operation suites and by the compile fence. Kept in one
// place so the tests and the fence assert against the same descriptors, and so tsc sees them
// (the app tsconfig excludes *.test.ts). No app code imports this module.

export const WORKSPACE_ROWS_SCHEMA = z.object({
  worktrees: z.array(z.object({ id: z.string() }))
})

const LEGACY_WORKSPACE_ROWS_SCHEMA = z.array(z.object({ id: z.string() }))

export type WorkspaceRows = z.output<typeof WORKSPACE_ROWS_SCHEMA>
export type LegacyWorkspaceRows = z.output<typeof LEGACY_WORKSPACE_ROWS_SCHEMA>

export const workspaceRowsReader = rpcResultVariant('rows', WORKSPACE_ROWS_SCHEMA)

/** Two semantic variants: the modern envelope, then a host that answered a bare array. */
export const workspaceRowsOrLegacyReader: RpcCompatibleReader<
  unknown,
  'rows' | 'legacy-array',
  WorkspaceRows | LegacyWorkspaceRows
> = rpcResultVariants<'rows' | 'legacy-array', WorkspaceRows | LegacyWorkspaceRows>([
  workspaceRowsReader,
  rpcResultVariant('legacy-array', LEGACY_WORKSPACE_ROWS_SCHEMA)
])

export const workspaceListOrThrow = defineRpcOperation({
  name: 'test.workspaceListOrThrow',
  method: 'worktree.ps',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  consumes: ['worktrees.id'],
  schedules: [],
  read: workspaceRowsOrLegacyReader
})

// Same method, a different family: main's callers disagreed about acceptance, so both rules
// stay named rather than being unified behind one descriptor.
export const workspaceListOrNull = defineRpcOperation({
  name: 'test.workspaceListOrNull',
  method: 'worktree.ps',
  acceptance: 'object-result-or-null',
  barrier: 'on-settle',
  consumes: ['worktrees.id'],
  schedules: [],
  read: workspaceRowsReader
})

export const worktreePsProbe = defineRpcOperation({
  name: 'test.worktreePsProbe',
  method: 'worktree.ps',
  acceptance: 'method-not-found-refusal',
  barrier: 'on-settle',
  consumes: [],
  schedules: []
})

export const terminalStreamOpener = defineRpcOperation({
  name: 'test.terminalStreamOpener',
  method: 'terminal.subscribe',
  acceptance: 'streaming-opener',
  barrier: 'on-settle',
  consumes: [],
  schedules: []
})

export const workspaceListAtBarrier = defineRpcOperation({
  name: 'test.workspaceListAtBarrier',
  method: 'worktree.ps',
  acceptance: 'require-result-or-throw',
  barrier: 'after-all-requests',
  consumes: ['worktrees.id'],
  schedules: ['test-poll'],
  read: workspaceRowsReader
})

export const terminalListAtBarrier = defineRpcOperation({
  name: 'test.terminalListAtBarrier',
  method: 'terminal.list',
  acceptance: 'object-result-or-null',
  barrier: 'after-all-requests',
  consumes: ['terminals'],
  schedules: [],
  read: rpcResultVariant('terminals', z.object({ terminals: z.array(z.unknown()) }))
})

export const worktreePsProbeAtBarrier = defineRpcOperation({
  name: 'test.worktreePsProbeAtBarrier',
  method: 'worktree.ps',
  acceptance: 'method-not-found-refusal',
  barrier: 'after-all-requests',
  consumes: [],
  schedules: []
})

export function rpcSuccess(result: unknown, streaming?: true): RpcResponse {
  return {
    id: 'rpc-1',
    ok: true,
    result,
    _meta: { runtimeId: 'runtime-1' },
    ...(streaming ? { streaming } : {})
  }
}

export function rpcRefusal(code: string, message = 'Nope'): RpcResponse {
  return { id: 'rpc-1', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}
