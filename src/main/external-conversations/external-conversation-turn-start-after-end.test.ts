import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { chatPaneKey } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { ConversationEvent } from './external-conversation-events'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'

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
function endedTurn(
  begin: (
    chats: ChatTurns,
    show: (next: Row) => void,
    hostRuns: (next: string, waits?: boolean) => void,
    end: () => void,
    put: (next: Row) => void
  ) => void = told
) {
  const events: ConversationEvent[] = []
  let row: Row = { state: 'working', stateStartedAt: SENT }
  // The message that opened the turn the host runs now.
  let opener = 'send-a'
  // Whether a delivery the chat took waits for a turn to name it.
  let waiting = false
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
    chatTurnWaiting: () => waiting,
    runningTurnReported: () => false,
    workLinks: async () => [],
    promptsAudience: () => true,
    turnOpener: () => ({ itemId: opener }) as unknown as AgentJournalRenderItem,
    keepAdoptedTurn: () => {},
    turnStartedAt: () => null
  })
  const show = (next: Row) => {
    row = next
    chats.observe(paneKey)
  }
  const starts = () => events.flatMap((event) => (event.kind === 'turn-started' ? [event.at] : []))
  // The host's turn end; its answer is still being read.
  const end = () =>
    chats.news({
      kind: 'turn-ended',
      sessionId,
      outcome: 'success',
      readTurn: () => new Promise<EndedChatTurn>(() => {}),
      at: ENDED
    })
  begin(
    chats,
    show,
    (next, waits = false) => {
      opener = next
      waiting = waits
    },
    end,
    (next) => {
      row = next
    }
  )
  waiting = false
  end()
  return { chats, show, starts, end }
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

  it('tells the host’s next turn whose row was read before the last turn’s end', () => {
    const { show, starts } = endedTurn((_chats, show, hostRuns) => {
      told(_chats, show)
      // The host ended the turn and began the next before its end was heard: the row reads working
      // under the next turn's date, still taken for the open turn.
      hostRuns('send-b')
      show({ state: 'working', stateStartedAt: ENDED + 100 })
    })
    expect(starts()).toEqual([SENT])
    show({ state: 'working', stateStartedAt: ENDED + 100 })
    expect(starts()).toEqual([SENT, ENDED + 100])
  })

  it('keeps the next turn running when its row came before the last turn’s end', () => {
    const { chats, show, starts } = endedTurn((_chats, show, hostRuns) => {
      told(_chats, show)
      // A follow-up waits; the row reads it working before the last turn's end is heard.
      hostRuns('send-b', true)
      show({ state: 'working', stateStartedAt: ENDED - 1_000 })
    })
    expect(starts()).toEqual([SENT, ENDED - 1_000])
    // The end heard belongs to the turn before: the follow-up's row is still a running turn.
    show({ state: 'working', stateStartedAt: ENDED - 1_000 })
    expect(
      chats.dates.leadWorking(paneKey, {
        state: 'working',
        stateStartedAt: ENDED - 1_000,
        structuredHost: true
      } as unknown as AgentStatusIpcPayload)
    ).toBe(true)
    expect(chats.turnOf(paneKey)).toBe(ENDED - 1_000)
  })

  it('tells the host’s next turn after a turn the conversation took over mid-run', () => {
    const { show, starts } = endedTurn((chats, show, hostRuns, _end, put) => {
      // A new watch takes over the running turn from its row.
      put({ state: 'working', stateStartedAt: HANDED_OVER })
      chats.adopt(paneKey)
      // The host ends it and begins the next before the end is heard.
      hostRuns('send-b')
      show({ state: 'working', stateStartedAt: ENDED + 100 })
    })
    show({ state: 'working', stateStartedAt: ENDED + 100 })
    expect(starts()).toEqual([ENDED + 100])
  })

  it('stays in step after a watch gap in which a turn ended unheard', () => {
    const { show, starts } = endedTurn((chats, show, hostRuns) => {
      told(chats, show)
      // The watch goes; the turn's end is not heard. The next turn runs once a watch is back.
      chats.clear()
      hostRuns('send-c')
      show({ state: 'working', stateStartedAt: ENDED - 3_000 })
    })
    expect(starts()).toEqual([SENT, ENDED - 3_000])
    // That turn ended: its own row read again is no new turn.
    show({ state: 'working', stateStartedAt: ENDED - 3_000 })
    expect(starts()).toEqual([SENT, ENDED - 3_000])
  })

  it('stays in step when a turn told before the last end is told again', () => {
    const { show, starts, end } = endedTurn((chats, show, hostRuns) => {
      told(chats, show)
      hostRuns('send-b', true)
      show({ state: 'working', stateStartedAt: ENDED - 1_000 })
    })
    // The end heard was the turn before; the follow-up is told again from its row, then ends.
    show({ state: 'working', stateStartedAt: ENDED - 1_000 })
    end()
    show({ state: 'working', stateStartedAt: ENDED - 1_000 })
    // The turn after it ends too: its own row read again is no new turn either.
    show({ state: 'done', stateStartedAt: ENDED })
    show({ state: 'working', stateStartedAt: ENDED + 5_000 })
    end()
    show({ state: 'working', stateStartedAt: ENDED + 5_000 })
    expect(starts()).toEqual([SENT, ENDED - 1_000, ENDED - 1_000, ENDED + 5_000])
  })
})
