import { z } from 'zod'
import type { RpcResponse } from './types'
import type { RpcCompatibleReader } from './rpc-operation-contract'
import { rpcResultVariant, rpcResultVariants } from './rpc-operation-result-reader'
import { defineRpcOperation } from './rpc-operation'

// Share descriptors with the compile fence outside *.test.ts so the app typecheck includes them.

export const WORKSPACE_ROWS_SCHEMA = z.object({
  worktrees: z.array(z.object({ id: z.string() }))
})

const LEGACY_WORKSPACE_ROWS_SCHEMA = z.array(z.object({ id: z.string() }))

export type WorkspaceRows = z.output<typeof WORKSPACE_ROWS_SCHEMA>
export type LegacyWorkspaceRows = z.output<typeof LEGACY_WORKSPACE_ROWS_SCHEMA>

export const workspaceRowsReader = rpcResultVariant('rows', WORKSPACE_ROWS_SCHEMA)

// Accept the modern envelope before the legacy bare-array variant.
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
  read: workspaceRowsOrLegacyReader
})

// Keep distinct acceptance families even when they use the same method.
export const workspaceListOrNull = defineRpcOperation({
  name: 'test.workspaceListOrNull',
  method: 'worktree.ps',
  acceptance: 'object-result-or-null',
  barrier: 'on-settle',
  read: workspaceRowsReader
})

export const worktreePsProbe = defineRpcOperation({
  name: 'test.worktreePsProbe',
  method: 'worktree.ps',
  acceptance: 'method-not-found-refusal',
  barrier: 'on-settle'
})

export const pushTestWithoutParams = defineRpcOperation({
  name: 'test.pushTestWithoutParams',
  method: 'notifications.testPush',
  acceptance: 'method-not-found-refusal',
  barrier: 'on-settle'
})

export const terminalStreamOpener = defineRpcOperation({
  name: 'test.terminalStreamOpener',
  method: 'terminal.subscribe',
  acceptance: 'streaming-opener',
  barrier: 'on-settle'
})

export const workspaceListAtBarrier = defineRpcOperation({
  name: 'test.workspaceListAtBarrier',
  method: 'worktree.ps',
  acceptance: 'require-result-or-throw',
  barrier: 'after-all-requests',
  read: workspaceRowsReader
})

export const terminalListAtBarrier = defineRpcOperation({
  name: 'test.terminalListAtBarrier',
  method: 'terminal.list',
  acceptance: 'object-result-or-null',
  barrier: 'after-all-requests',
  read: rpcResultVariant('terminals', z.object({ terminals: z.array(z.unknown()) }))
})

export const worktreePsProbeAtBarrier = defineRpcOperation({
  name: 'test.worktreePsProbeAtBarrier',
  method: 'worktree.ps',
  acceptance: 'method-not-found-refusal',
  barrier: 'after-all-requests'
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
