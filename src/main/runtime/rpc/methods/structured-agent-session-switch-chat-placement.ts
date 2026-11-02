import type { RpcContext } from '../core'
import type { StructuredSessionTabPublicationInput } from '../../session-tabs/structured-session-tab-publication'
import type { ChatTabPlacement } from '../../agent-session/agent-session-tab-layout'
import { agentLaunchMovesHostWindow } from './agent-launch-tab-publication'
import { switchChatSlot } from '../../session-tabs/switch-slot-anchors'
import { logicalTabHolding } from '../../session-tabs/session-tab-content-swap'
import { agentSessionRowId } from '../../../../shared/agent-session/view/structured-agent-session-host-tab-id'

/**
 * The chat direction's one layout write: the stopped terminal's tab now holds the chat, in place,
 * if it still holds just that terminal. A split pane's tab keeps its other panes, so the chat
 * opens beside it; a source in another workspace keeps its tab untouched; a tab the user closed
 * meanwhile, or a source the client could only name, opens the chat as an ordinary tab. Returns
 * whether the chat now fills the terminal's tab.
 */
export async function placeSwitchChat(
  ctx: RpcContext,
  chat: Omit<StructuredSessionTabPublicationInput, 'activate'>,
  source: {
    /** The stopped terminal, when it was in the chat's workspace; `wholeTab` when it was the
     *  tab's only pane. */
    terminalId?: string
    wholeTab: boolean
    besideTabId?: string
    placement?: () => ChatTabPlacement | undefined
  },
  check: () => void
): Promise<boolean> {
  const { workspaceId, sessionId } = chat
  const terminal = { kind: 'terminal' as const, terminalId: source.terminalId ?? '' }
  const content = { kind: 'agent-session' as const, sessionId, agent: chat.agent }
  const switched =
    source.terminalId && source.wholeTab
      ? await ctx.runtime.setSwitchedTabContent(workspaceId, {
          tabId:
            logicalTabHolding(ctx.runtime.mobileSessionTabsByWorktree.get(workspaceId), terminal) ??
            source.terminalId,
          expectSource: terminal,
          window: content,
          layout: content,
          focus: agentLaunchMovesHostWindow(ctx)
        })
      : undefined
  if (switched?.retargeted && switched.tabId) {
    // The commit point: the chat's saved tab is the tab the layout owner changed. Once that tab
    // holds the chat nothing may refuse this write, or the chat would have no saved tab.
    await ctx.runtime.publishStructuredAgentSessionTab({
      ...chat,
      tabId: switched.tabId,
      inTab: switched.tabId,
      activate: false
    })
    return true
  }
  const slot = switchChatSlot(source.besideTabId, source.placement)
  await ctx.runtime.switchSlotAnchors.recordFor(
    workspaceId,
    agentSessionRowId(sessionId),
    slot.anchor,
    () =>
      ctx.runtime.publishStructuredAgentSessionTab({
        ...chat,
        activate: true,
        check,
        focusWindow: agentLaunchMovesHostWindow(ctx),
        ...slot.publish
      })
  )
  return false
}
