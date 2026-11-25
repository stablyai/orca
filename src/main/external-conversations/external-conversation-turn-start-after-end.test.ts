import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { chatPaneKey } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { ConversationEvent } from './external-conversation-events'

const sessionId = 'chat-1'
const paneKey = chatPaneKey(sessionId)
const link: ExternalConversationLink = {
  source: 'slack',
  externalId: 'T0TEAM:C0CHANNEL:1.0:U0BOT',
  sessionId,
  agent: 'claude',
  paneKey,
  bot: { kind: 'bot', botId: 'bot-1' },
  createdAt: 0
}

// The send's time, then its handover once the turn runs; the host records the end later.
const SENT = 1_000
const HANDED_OVER = 1_400
const ENDED = 18_000

type Row = { state: 'working' | 'done'; stateStartedAt: number }

// A linked chat whose turn was told at SENT and re-dated to HANDED_OVER, its end now being read.
function endedTurn() {
  const events: ConversationEvent[] = []
  let row: Row = { state: 'working', stateStartedAt: SENT }
  const chats = new ChatTurns({
    setTimer: () => ({ cancel: () => {} }),
    now: () => ENDED,
    workerActivities: async () => null,
    linkedFor: () => ({ link, workspace: { worktreeId: 'wt', sshHostId: null } }),
    emit: (event) => events.push(event),
    readHookRow: () => ({ ...row, structuredHost: true }) as unknown as AgentStatusIpcPayload,
    pendingPrompt: () => null,
    chatTurnOrigin: () => 'delivery',
    // Published turn state lags the host's feed: the delivery still reads as the chat's.
    chatTurnDelivered: () => true,
    chatTurnDelivery: () => 'delivery-1',
    chatTurnWaiting: () => false,
    runningTurnReported: () => false,
    workLinks: async () => [],
    promptsAudience: () => true,
    turnOpener: () => null,
    keepAdoptedTurn: () => {},
    turnStartedAt: () => null
  })
  const show = (next: Row) => {
    row = next
    chats.observe(paneKey)
  }
  const starts = () => events.flatMap((event) => (event.kind === 'turn-started' ? [event.at] : []))
  show({ state: 'working', stateStartedAt: SENT })
  show({ state: 'working', stateStartedAt: HANDED_OVER })
  chats.news({
    kind: 'turn-ended',
    sessionId,
    outcome: 'success',
    // The answer is still being read.
    readTurn: () => new Promise<EndedChatTurn>(() => {}),
    at: ENDED
  })
  return { chats, show, starts }
}

describe('a chat turn’s status row after the turn ended', () => {
  it('tells no new turn from the ended turn’s own row, and tells the next real one', () => {
    const { show, starts } = endedTurn()
    expect(starts()).toEqual([SENT])
    // The row reads working once more under the ended turn's handover before it reads done.
    show({ state: 'working', stateStartedAt: HANDED_OVER })
    show({ state: 'working', stateStartedAt: SENT })
    expect(starts()).toEqual([SENT])
    show({ state: 'done', stateStartedAt: ENDED })
    show({ state: 'working', stateStartedAt: ENDED + 2_000 })
    expect(starts()).toEqual([SENT, ENDED + 2_000])
  })

  it('tells a real next turn whose handover came before the last end', () => {
    const { show, starts } = endedTurn()
    // A send handed over during the turn waited to join it; the turn ended first, so it runs as a
    // turn of its own, dated at its handover.
    show({ state: 'working', stateStartedAt: ENDED - 500 })
    expect(starts()).toEqual([SENT, ENDED - 500])
  })

  it('reports no turn running from the ended turn’s row on a new watch', () => {
    const { chats, show } = endedTurn()
    show({ state: 'working', stateStartedAt: HANDED_OVER })
    expect(chats.adopt(paneKey)).toBeNull()
    show({ state: 'working', stateStartedAt: ENDED - 500 })
    expect(chats.toldTurn(paneKey)).toBe(ENDED - 500)
  })
})
