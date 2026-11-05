import { z } from 'zod'
import {
  structuredSessionOpenFailure,
  type StructuredSessionOpenFailure
} from '../../../src/shared/open-structured-agent-session'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { sessionTerminalFocus } from './mobile-session-write-operations'
import { sessionTabsListRead } from './mobile-session-read-operations'

const focusSchema = z.object({ focus: z.object({ worktreeId: z.string().min(1) }) })
const tabsSchema = z.object({
  tabs: z.array(
    z.object({
      type: z.string(),
      id: z.string().min(1),
      terminal: z.string().nullable().optional(),
      parentTabId: z.string().optional(),
      leafId: z.string().optional()
    })
  )
})

export async function openMobileAgentMessageTerminal(
  client: RpcClient,
  handle: string,
  current: () => boolean,
  deadline: number
): Promise<{ worktreeId: string; paneKey: string } | { failure: StructuredSessionOpenFailure }> {
  const stage = async (request: (options: SendRequestOptions) => Promise<RpcResponse>) => {
    if (!current() || client.getState() !== 'connected' || Date.now() >= deadline) {
      throw new Error('Opening no longer belongs to this view')
    }
    const response = await request({
      timeoutMs: Math.min(5000, deadline - Date.now()),
      budgetSpansConnect: true,
      failWhenDisconnected: true
    })
    if (!current() || client.getState() !== 'connected' || Date.now() >= deadline) {
      throw new Error('Opening no longer belongs to this view')
    }
    if (!response.ok) {
      throw Object.assign(new Error('Terminal could not open'), response.error)
    }
    return response.result
  }
  try {
    const { focus } = focusSchema.parse(
      await stage((options) =>
        sessionTerminalFocus.request(client, { terminal: handle, navigation: 'caller' }, options)
      )
    )
    const { tabs } = tabsSchema.parse(
      await stage((options) =>
        sessionTabsListRead.request(client, { worktree: `id:${focus.worktreeId}` }, options)
      )
    )
    const tab = tabs.find((tab) => tab.type === 'terminal' && tab.terminal === handle)
    if (!tab?.leafId) {
      throw new Error('Terminal is not in the current inventory')
    }
    return { worktreeId: focus.worktreeId, paneKey: `${tab.parentTabId ?? tab.id}:${tab.leafId}` }
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null
    const failure: StructuredSessionOpenFailure =
      code === 'terminal_exited' ||
      code === 'terminal_gone' ||
      code === 'terminal_handle_stale' ||
      code === 'terminal_not_found'
        ? { reason: 'gone', surface: 'terminal', beforeEffects: false }
        : structuredSessionOpenFailure(error)
    return { failure }
  }
}
