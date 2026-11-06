/** Paired phones send no telemetry of their own; the host they drive records what reaches it. */

import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeMobileSessionSnapshotTab } from '../../shared/runtime-mobile-session-tab-contracts'
import { track } from './client'

type ClientKind = 'mobile' | 'runtime' | undefined

// Structured provider ids share their names with TUI agents; unknown ids map to other.
function agentKind(agent: string | null | undefined) {
  return agent ? tuiAgentToAgentKind(agent as TuiAgent) : undefined
}

/** Desktop windows count their own composer, so only a phone's accepted send counts here. */
export function recordMobileChatSend(
  clientKind: ClientKind,
  agent: string | null,
  result: { ok: boolean }
): void {
  if (clientKind !== 'mobile' || !result.ok) {
    return
  }
  track('native_chat_message_sent', {
    agent_kind: agentKind(agent) ?? 'other',
    runtime: 'local',
    client: 'mobile'
  })
}

// Reconnects and tab switches re-activate the same tab; one row per phone, tab and day is enough.
let openedDay = ''
const openedToday = new Set<string>()

export function recordMobileSessionOpened(args: {
  clientKind: ClientKind
  deviceId: string | undefined
  worktree: string
  tab: RuntimeMobileSessionSnapshotTab | undefined
  paneAgent: (ptyId: string | null | undefined) => string | null
  now?: Date
}): void {
  const { tab } = args
  if (args.clientKind !== 'mobile' || !tab) {
    return
  }
  // Browser and file tabs carry no agent, so they say nothing about chat versus terminal.
  if (tab.type !== 'agent-session' && tab.type !== 'terminal') {
    return
  }
  const day = (args.now ?? new Date()).toISOString().slice(0, 10)
  if (day !== openedDay) {
    openedDay = day
    openedToday.clear()
  }
  const key = `${args.deviceId ?? ''}\0${args.worktree}\0${tab.id}`
  if (openedToday.has(key)) {
    return
  }
  openedToday.add(key)
  const chat = tab.type === 'agent-session' || tab.viewMode === 'chat'
  const kind = agentKind(
    tab.type === 'agent-session' ? tab.agent : (tab.launchAgent ?? args.paneAgent(tab.ptyId))
  )
  track('mobile_session_opened', {
    surface: chat ? 'chat' : 'terminal',
    ...(kind ? { agent_kind: kind } : {})
  })
}
