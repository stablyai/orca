import type { RpcContext } from '../core'
import type { StructuredSessionTabPublicationInput } from '../../session-tabs/structured-session-tab-publication'
import type { ChatTabPlacement } from '../../agent-session/agent-session-tab-layout'
import { agentLaunchMovesHostWindow } from './agent-launch-tab-publication'
import { switchChatSlot } from '../../session-tabs/switch-slot-anchors'
import { logicalTabHolding } from '../../session-tabs/session-tab-content-swap'
import { agentSessionRowId } from '../../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'

/**
 * The chat direction's one layout write, in commit order: the stopped terminal's tab will hold
 * the chat, if it still holds just that terminal; the chat's record names that tab (`commit`, the
 * switch's commit point); then the tab takes the chat in place. A split pane's tab keeps its other
 * panes, so the chat opens beside it; a source in another workspace keeps its tab untouched; a tab
 * the user changed before the write, or a source the client could only name, opens the chat as an
 * ordinary tab where the layout owner says, its record following it there. After the commit the
 * chat's record is the authority: the tab's rows only show it (never a second open), and only while
 * no later close, reopen or switch wrote that record. Returns whether the chat took the terminal's
 * tab.
 */
export async function placeSwitchChat(
  ctx: RpcContext,
  host: Pick<
    StructuredAgentSessionHost,
    'setSessionTabVisibility' | 'getSessionTabId' | 'getSessionTabGeneration'
  >,
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
  /** Whether the record is still the one this switch wrote. */
  let current = (): boolean => true
  const record = async (tabId: string, admit: () => void): Promise<void> => {
    let generation = -1
    await host.setSessionTabVisibility(sessionId, true, tabId, {
      check: admit,
      move: true,
      capture: (_tabId, written) => {
        generation = written
      }
    })
    current = () => host.getSessionTabGeneration(sessionId) === generation
  }
  const project = (tabId: string): void =>
    ctx.runtime.projectStructuredAgentSessionTab({
      ...chat,
      tabId,
      inTab: tabId,
      activate: false,
      eligible: current
    })
  // The switched tab becomes the conversation's chat tab, also when the chat was open in another
  // tab: that one goes in the same write, and the chat's one record moves here (Brennan: "same
  // session, so same tab").
  const switched =
    source.terminalId && source.wholeTab
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
            await record(tabId, check)
            committed()
            return current
          },
          // An answer after the wait shows the chat only while this switch is still current.
          (late) => {
            if (late.kind === 'applied' && current()) {
              project(late.tabId)
            }
          }
        )
      : undefined
  if (switched?.kind === 'applied') {
    project(switched.tabId)
    return true
  }
  if (switched?.kind === 'superseded' || switched?.kind === 'unknown') {
    return true
  }
  // The chat's actual tab, as the layout owner has its tabs: never the switched tab, which the
  // user changed (a refused write) or which stays the split source's.
  const tabId =
    switched?.destination ?? (await ctx.runtime.switchChatTabId(workspaceId, sessionId, chat.agent))
  if (switched?.committed) {
    // Refused before it applied: the record follows the chat there unless a later close or
    // switch wrote it since.
    const committedRecord = current
    await record(tabId, () => {
      check()
      if (!committedRecord()) {
        throw new Error('Chat tab publication was superseded')
      }
    })
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
        tabId,
        activate: true,
        check,
        focusWindow: agentLaunchMovesHostWindow(ctx),
        ...(switched?.committed ? { committed: current } : {}),
        ...slot.publish
      })
  )
  return false
}
