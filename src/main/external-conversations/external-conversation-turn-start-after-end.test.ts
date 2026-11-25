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

type Row = { state: 'working' | 'done' | 'blocked'; stateStartedAt: number }

// The turn told at its send, then re-dated to its handover.
const told = (_chats: ChatTurns, show: (next: Row) => void) => {
  show({ state: 'working', stateStartedAt: SENT })
  show({ state: 'working', stateStartedAt: HANDED_OVER })
}

// A linked chat whose turn began as `begin` says, its end now being read.
function endedTurn(begin: (chats: ChatTurns, show: (next: Row) => void) => void = told) {
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
  begin(chats, show)
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

  it('reports no turn running from the ended turn’s row on the next watch', () => {
    const { chats, show } = endedTurn()
    show({ state: 'working', stateStartedAt: HANDED_OVER })
    // The watch goes and a new one opens with a snapshot, while the row still reads working.
    chats.clear()
    expect(chats.adopt(paneKey)).toBeNull()
    show({ state: 'working', stateStartedAt: ENDED - 500 })
    expect(chats.toldTurn(paneKey)).toBe(ENDED - 500)
  })

  it('tells no new turn from the row of a turn joined at its prompt, once it ended', () => {
    const { show, starts } = endedTurn((chats, show) => {
      show({ state: 'blocked', stateStartedAt: SENT + 5_000 })
      chats.joined(paneKey, sessionId)
      // The prompt answered, the row runs under the turn's handover.
      show({ state: 'working', stateStartedAt: HANDED_OVER })
    })
    expect(starts()).toEqual([SENT + 5_000])
    show({ state: 'working', stateStartedAt: HANDED_OVER })
    expect(starts()).toEqual([SENT + 5_000])
  })

  it('snapshots the ended turn’s row as not working', () => {
    const { chats, show } = endedTurn()
    show({ state: 'working', stateStartedAt: HANDED_OVER })
    const row = (at: number) =>
      ({
        state: 'working',
        stateStartedAt: at,
        structuredHost: true
      }) as unknown as AgentStatusIpcPayload
    expect(chats.dates.leadWorking(paneKey, row(HANDED_OVER))).toBe(false)
    expect(chats.dates.leadWorking(paneKey, row(ENDED - 500))).toBe(true)
  })
})
