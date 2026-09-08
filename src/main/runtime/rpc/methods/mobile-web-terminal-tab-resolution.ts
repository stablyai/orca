import { z } from 'zod'
import type { RpcContext } from '../core'

const TerminalTab = z.object({
  id: z.string(),
  type: z.literal('terminal'),
  status: z.literal('ready'),
  terminal: z.string().min(1).max(256),
  isActive: z.boolean().optional()
})

/** The host tab list is the only authority on which PTY a page-visible tab id names. */
export async function resolveMobileWebTerminalTab(
  context: RpcContext,
  worktree: string,
  tabId: string,
  options: { requireActive?: boolean } = {}
): Promise<string> {
  const snapshot = await context.runtime.listMobileSessionTabs(worktree, context.pairedDeviceId)
  if (`id:${snapshot.worktree}` !== worktree) {
    throw new Error('selector_not_found')
  }
  const parsed = TerminalTab.safeParse(snapshot.tabs.find((tab) => tab.id === tabId))
  if (!parsed.success) {
    throw new Error('selector_not_found')
  }
  if (options.requireActive && (snapshot.activeTabId !== tabId || parsed.data.isActive !== true)) {
    throw new Error('selector_not_found')
  }
  return parsed.data.terminal
}
