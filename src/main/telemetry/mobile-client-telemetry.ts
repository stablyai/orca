/** Paired phones send no telemetry of their own; the host they drive records what reaches it. */

import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import { track } from './client'

type ClientKind = 'mobile' | 'runtime' | undefined

// Structured provider ids share their names with TUI agents; unknown ids map to other.
function agentKind(agent: string | null | undefined) {
  if (!agent) {
    return undefined
  }
  return isTuiAgent(agent) ? tuiAgentToAgentKind(agent) : 'other'
}

/** Desktop windows count their own composer, so only a phone's accepted send counts here. */
export function recordMobileChatSend(
  clientKind: ClientKind,
  agent: string | null,
  result: { ok: true; replayed: boolean } | { ok: false }
): void {
  // A replayed mutation answers an earlier send; it is not a new message.
  if (clientKind !== 'mobile' || !result.ok || result.replayed) {
    return
  }
  track('native_chat_message_sent', {
    agent_kind: agentKind(agent) ?? 'other',
    // The renderer classifies its own execution target; a phone's request carries no such fact.
    runtime: 'unknown',
    client: 'mobile'
  })
}

// Reconnects, transport moves and view switches reopen the same stream; one row per phone,
// view, surface and day is enough, and the set is dropped when the day turns.
let openedDay = ''
const openedToday = new Set<string>()

/** A phone opened a chat transcript or a full terminal stream: what it actually shows, which
 *  only the phone decides. The input-only stream under a phone's chat view is not counted. */
export function recordMobileViewOpened(
  caller: { clientKind?: ClientKind; pairedDeviceId?: string },
  args: {
    surface: 'chat' | 'terminal'
    /** Names the chat or terminal, namespaced by stream kind. */
    viewKey: string
    /** Read only for a view not yet counted today. */
    agent: () => string | null
    now?: Date
  }
): void {
  if (caller.clientKind !== 'mobile') {
    return
  }
  const day = (args.now ?? new Date()).toISOString().slice(0, 10)
  if (day !== openedDay) {
    openedDay = day
    openedToday.clear()
  }
  const key = `${caller.pairedDeviceId ?? ''}\0${args.surface}\0${args.viewKey}`
  if (openedToday.has(key)) {
    return
  }
  openedToday.add(key)
  // A count must never end the stream it observes.
  try {
    const kind = agentKind(args.agent())
    track('mobile_session_opened', {
      surface: args.surface,
      ...(kind ? { agent_kind: kind } : {})
    })
  } catch (error) {
    console.warn('[telemetry] mobile view count failed', error)
  }
}
