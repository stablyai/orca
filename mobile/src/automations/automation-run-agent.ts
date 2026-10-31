import { z } from 'zod'
import {
  normalizeVisibleExecutionHostIds,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import { hostScopeCensusIsComplete } from '../../../src/shared/runtime-listing-host-scope'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileAutomationRun } from './automation-reply-schema'

const terminalList = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.mobile-automation-original-pane',
    method: 'terminal.list',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'original-pane-inventory',
      z.object({
        terminals: z.array(
          z.object({
            worktreeId: z.string(),
            tabId: z.string(),
            leafId: z.string(),
            ptyId: z.string().nullable(),
            connected: z.boolean(),
            orphaned: z.boolean().optional(),
            verdict: z.enum(['live', 'exited', 'unverifiable']).optional()
          })
        ),
        totalCount: z.unknown().optional(),
        truncated: z.unknown().optional(),
        hostScope: z.unknown().optional()
      })
    )
  })
)
const coverage = z.object({
  hostIds: z.array(z.string()).transform((ids) => normalizeVisibleExecutionHostIds(ids) ?? []),
  omittedHostIds: z.array(
    z.custom<ExecutionHostId>(
      (value) => typeof value === 'string' && Boolean(parseExecutionHostId(value))
    )
  )
})
export async function canOpenAutomationRunAgent(
  client: RpcClient,
  run: MobileAutomationRun
): Promise<'available' | 'unavailable' | 'unverifiable'> {
  const pane = parsePaneKey(run.terminalPaneKey ?? '')
  if (!pane || !run.workspaceId) {
    return 'unavailable'
  }
  let limit: number | undefined
  try {
    for (let read = 0; read < 2; read++) {
      const reply = terminalList.interpret(
        await terminalList.request(client, {
          worktree: `id:${run.workspaceId}`,
          includeVisualLayouts: false,
          ...(limit === undefined ? {} : { limit })
        })
      )
      const terminal = reply.terminals.find(
        (entry) =>
          entry.worktreeId === run.workspaceId &&
          entry.tabId === pane.tabId &&
          entry.leafId === pane.leafId &&
          (!run.terminalPtyId || entry.ptyId === run.terminalPtyId)
      )
      if (
        terminal &&
        !terminal.orphaned &&
        terminal.ptyId &&
        (terminal.verdict === 'live' || (terminal.verdict === undefined && terminal.connected))
      ) {
        return 'available'
      }
      if (terminal?.verdict === 'unverifiable') {
        return 'unverifiable'
      }
      const scope = coverage.safeParse(reply.hostScope)
      const count = reply.totalCount
      if (
        !scope.success ||
        !hostScopeCensusIsComplete(scope.data) ||
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < reply.terminals.length ||
        typeof reply.truncated !== 'boolean'
      ) {
        return 'unverifiable'
      }
      if (limit !== undefined && count > limit) {
        return 'unverifiable'
      }
      if (!reply.truncated && count === reply.terminals.length) {
        return 'unavailable'
      }
      if (read || !reply.truncated || count <= reply.terminals.length) {
        return 'unverifiable'
      }
      limit = count
    }
  } catch {
    return 'unverifiable'
  }
  return 'unverifiable'
}
