import { z } from 'zod'
import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import { sessionTerminalListRead } from '../session/mobile-session-read-operations'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileAutomationRun } from './automation-reply-schema'

const terminalIdentity = z.object({
  tabId: z.string(),
  leafId: z.string(),
  ptyId: z.string().nullable(),
  orphaned: z.boolean().optional(),
  verdict: z.string().optional()
})
export async function canOpenAutomationRunAgent(
  client: RpcClient,
  run: MobileAutomationRun
): Promise<boolean> {
  const pane = parsePaneKey(run.terminalPaneKey ?? '')
  if (!pane || !run.workspaceId) {
    return false
  }
  const reply = sessionTerminalListRead.interpret(
    await sessionTerminalListRead.request(client, {
      worktree: `id:${run.workspaceId}`,
      includeVisualLayouts: false
    })
  )
  return (
    reply.accepted &&
    reply.value.terminals.some((raw) => {
      const parsed = terminalIdentity.safeParse(raw)
      if (!parsed.success) {
        return false
      }
      const terminal = parsed.data
      return (
        !terminal.orphaned &&
        terminal.verdict !== 'unverifiable' &&
        terminal.tabId === pane.tabId &&
        terminal.leafId === pane.leafId &&
        (!run.terminalPtyId || run.terminalPtyId === terminal.ptyId)
      )
    })
  )
}
