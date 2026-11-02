import type { RpcContext } from '../core'
import type { StructuredSessionTabPublicationInput } from '../../session-tabs/structured-session-tab-publication'
import type { ChatTabPlacement } from '../../agent-session/agent-session-tab-layout'
import { agentLaunchMovesHostWindow } from './agent-launch-tab-publication'
import { switchChatSlot } from '../../session-tabs/switch-slot-anchors'
import { logicalTabHolding } from '../../session-tabs/session-tab-content-swap'
import { agentSessionRowId } from '../../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import { chatTabId } from '../../agent-session/agent-session-tab-layout'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'

/**
 * The chat direction's one layout write, in commit order: the stopped terminal's tab will hold
 * the chat, if it still holds just that terminal; the chat's record names that tab (`commit`, the
 * switch's commit point); then the tab takes the chat in place. A split pane's tab keeps its other
 * panes, so the chat opens beside it; a source in another workspace keeps its tab untouched; a tab
 * the user changed meanwhile, or a source the client could only name, opens the chat as an
 * ordinary tab, its record following it there. Returns whether the chat now fills the terminal's
 * tab.
 */
export async function placeSwitchChat(
  ctx: RpcContext,
  host: Pick<StructuredAgentSessionHost, 'setSessionTabVisibility'>,
  chat: Omit<StructuredSessionTabPublicationInput, 'activate'>,
  source: {
    /** The stopped terminal, when it was in the chat's workspace; `wholeTab` when it was the
     *  tab's only pane. */
    terminalId?: string
    wholeTab: boolean
    /** The terminal the chat opens beside, in the tab holding it. */
    besideTerminalId?: string
    placement?: () => ChatTabPlacement | undefined
  },
  check: () => void,
  committed: () => void
): Promise<boolean> {
  const { workspaceId, sessionId } = chat
  const terminal = { kind: 'terminal' as const, terminalId: source.terminalId ?? '' }
  const content = { kind: 'agent-session' as const, sessionId, agent: chat.agent }
  const shown = ctx.runtime.mobileSessionTabsByWorktree.get(workspaceId)
  let recorded = false
  // A chat already open in a tab (another one, or this switch's own after a lost answer) stays
  // where it is and is selected there, as opening any open chat does.
  const switched =
    source.terminalId &&
    source.wholeTab &&
    !logicalTabHolding(shown, { kind: 'agent-session', sessionId })
      ? await ctx.runtime.switchTabContent(
          workspaceId,
          {
            tabId: logicalTabHolding(shown, terminal) ?? source.terminalId,
            expectSource: terminal,
            window: content,
            layout: content,
            focus: agentLaunchMovesHostWindow(ctx)
          },
          async (tabId) => {
            await host.setSessionTabVisibility(sessionId, true, tabId, { check, move: true })
            recorded = true
            committed()
          }
        )
      : undefined
  if (switched?.retargeted && switched.tabId) {
    // Nothing may refuse this write now that the tab holds the chat: it projects the chat into
    // that tab's rows (its record already names the tab).
    await ctx.runtime.publishStructuredAgentSessionTab({
      ...chat,
      tabId: switched.tabId,
      inTab: switched.tabId,
      activate: false
    })
    return true
  }
  if (recorded) {
    // The tab refused at the write: the record follows the chat to its ordinary tab.
    await host.setSessionTabVisibility(sessionId, true, chatTabId(sessionId), { move: true })
  }
  const beside = source.besideTerminalId
  const slot = switchChatSlot(
    beside
      ? {
          terminalId: beside,
          tabId: logicalTabHolding(shown, { kind: 'terminal', terminalId: beside }) ?? beside
        }
      : undefined,
    source.placement
  )
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
