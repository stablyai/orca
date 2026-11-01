import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import type { MobileSessionTab } from '../../mobile-session-route-types'
import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'
import {
  agentMessageSenderLabel,
  agentMessageSenderView,
  type AgentMessageSenderView
} from '../../../../../src/shared/agent-session/agent-message-presentation'
import { resolveMobileTerminalTabAgentId } from '../../mobile-terminal-tab-agent'
import { agentDotState } from '../../../worktree/agent-row-display'

type Sender = AgentMessageSource['senders'][number]
type TerminalIdentity = { handle: string; agentIdentity?: string }
const EMPTY_VIEW: AgentMessageSenderView = Object.freeze({})
const senderKey = (sender: Sender | undefined) =>
  sender?.party.orcaSessionId
    ? `chat:${sender.party.orcaSessionId}`
    : `terminal:${sender?.party.terminalHandle ?? ''}`

export function createMobileAgentMessageSource() {
  let tabs: readonly MobileSessionTab[] | undefined
  let terminals: readonly TerminalIdentity[] | undefined
  let identities = new Map<string, string | undefined>()
  let indexed = new Map<
    string,
    { tab: MobileSessionTab; agentType: AgentMessageSenderView['agentType'] }
  >()
  let now = 0
  const views = new Map<string, AgentMessageSenderView>()
  const listeners = new Set<() => void>()
  return {
    update(
      nextTabs: readonly MobileSessionTab[],
      nextTerminals: readonly TerminalIdentity[],
      nextNow: number
    ) {
      if (terminals !== nextTerminals) {
        identities = new Map(
          nextTerminals.map((terminal) => [terminal.handle, terminal.agentIdentity])
        )
      }
      if (tabs !== nextTabs || terminals !== nextTerminals) {
        indexed = new Map()
        for (const tab of nextTabs) {
          if (tab.type === 'agent-session') {
            indexed.set(`chat:${tab.sessionId}`, { tab, agentType: tab.agent })
          } else if (tab.type === 'terminal' && tab.terminal) {
            indexed.set(`terminal:${tab.terminal}`, {
              tab,
              agentType:
                resolveMobileTerminalTabAgentId(tab, identities.get(tab.terminal)) ?? undefined
            })
          }
        }
      }
      if (tabs === nextTabs && terminals === nextTerminals && now === nextNow) {
        return
      }
      tabs = nextTabs
      terminals = nextTerminals
      now = nextNow
      listeners.forEach((notify) => notify())
    },
    subscribe(notify: () => void) {
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
    name(sender: Sender, fallback: string): string {
      const tab = indexed.get(senderKey(sender))?.tab
      return agentMessageSenderLabel({
        localChat: tab?.type === 'agent-session',
        customLabel: tab?.title,
        snapshotName: sender.name,
        tabLabel: tab?.title,
        fallback
      })
    },
    view(sender: Sender | undefined): AgentMessageSenderView {
      const key = senderKey(sender)
      const facts = indexed.get(key)
      const tab = facts?.tab
      const status =
        tab?.type === 'terminal'
          ? tab.agentStatus
          : tab?.type === 'agent-session'
            ? tab.chatStatus
            : undefined
      const next = facts
        ? agentMessageSenderView(
            status && !(tab?.type === 'terminal' && tab.agentStatus?.restoredUnconfirmed)
              ? { agentType: facts.agentType, dot: agentDotState(status, now) }
              : undefined,
            facts.agentType
          )
        : EMPTY_VIEW
      const previous = views.get(key)
      if (
        previous &&
        previous.agentType === next.agentType &&
        previous.dot === next.dot &&
        previous.progress === next.progress
      ) {
        return previous
      }
      views.set(key, next)
      return next
    }
  }
}
export const MobileAgentMessageContext = createContext<ReturnType<
  typeof createMobileAgentMessageSource
> | null>(null)
export const MobileAgentMessageOpenContext = createContext<
  ((from: AgentMessageSource, sender: Sender) => void) | undefined
>(undefined)
const noopSubscribe = () => () => {}
export function useMobileAgentMessageName(sender: Sender, fallback: string): string {
  const source = useContext(MobileAgentMessageContext)
  const read = useCallback(
    () =>
      source?.name(sender, fallback) ??
      agentMessageSenderLabel({ localChat: false, snapshotName: sender.name, fallback }),
    [source, sender, fallback]
  )
  return useSyncExternalStore(source?.subscribe ?? noopSubscribe, read, read)
}
export function useMobileAgentMessageView(sender: Sender | undefined): AgentMessageSenderView {
  const source = useContext(MobileAgentMessageContext)
  const read = useMemo(() => () => source?.view(sender) ?? EMPTY_VIEW, [source, sender])
  return useSyncExternalStore(source?.subscribe ?? noopSubscribe, read, read)
}
