import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ConnectorTurnOrigin } from '../../shared/connectors/connector-cloud-contract'
import { chatPaneKey } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { ConversationEvent } from './external-conversation-events'
import { wokenForConversation } from './external-conversation-wake-answers'

// A thread's turn starts background work and ends; the work finishing wakes the chat in a turn no
// one typed. That turn answers the thread, unless someone else asked the chat in between and left
// other work running, in which case Orca can't tell whose wake-up it is and keeps it in Orca.

const SESSION = 'chat-1'
const PANE = chatPaneKey(SESSION)
const workspace = { worktreeId: 'bot-home', sshHostId: null }

function harness() {
  let link: ExternalConversationLink = {
    source: 'slack',
    externalId: 'slack:T1:C1:1.2',
    sessionId: SESSION,
    agent: 'claude',
    paneKey: PANE,
    bot: { kind: 'bot', botId: 'bot-1' },
    lastTurn: 'conversation',
    createdAt: 1
  }
  let background: string[] = []
  let nextOrigin: ConnectorTurnOrigin = 'local'
  const events: ConversationEvent[] = []
  const row = (): AgentStatusIpcPayload => ({
    paneKey: PANE,
    structuredHost: 'owned',
    state: background.length ? 'working' : 'done',
    ...(background.length
      ? { workingMode: 'monitoring' as const, backgroundCommands: background }
      : {}),
    mainAgent: { state: 'done', stateStartedAt: 1 },
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    prompt: ''
  })
  // A restart builds new turns over the same saved link.
  const turns = () =>
    new ChatTurns({
      readHookRow: () => row(),
      linkedFor: () => ({ workspace, link }),
      emit: (event) => events.push(event),
      keepWakeAnswers: (_linked, wakeAnswers) => {
        const { wakeAnswers: _old, ...rest } = link
        link = wakeAnswers ? { ...rest, wakeAnswers } : rest
      },
      chatTurnOrigin: () => {
        const origin = nextOrigin
        nextOrigin = 'local'
        return origin
      },
      chatTurnDelivered: () => false,
      chatTurnDelivery: () => undefined,
      chatTurnWaiting: () => false,
      runningTurnReported: () => false,
      workLinks: async () => [],
      workerActivities: async () => null,
      promptsAudience: () => false,
      pendingPrompt: () => null,
      turnOpener: () => null,
      keepAdoptedTurn: () => {},
      setTimer: () => ({ cancel: () => {} }),
      now: () => 1
    })
  let chat = turns()
  const end = async (turn: EndedChatTurn, at: number): Promise<void> => {
    chat.news({
      kind: 'turn-ended',
      sessionId: SESSION,
      outcome: 'success',
      at,
      readTurn: async () => turn
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return {
    events,
    link: () => link,
    restart: () => (chat = turns()),
    run: (commands: string[]) => (background = commands),
    fromThread: () => (nextOrigin = 'delivery'),
    askedInOrca: () => (link = { ...link, lastTurn: 'orca' }),
    end,
    said: () =>
      events.flatMap((event) =>
        event.kind === 'turn-ended' && event.lastAssistantMessage
          ? [{ words: event.lastAssistantMessage, origin: event.origin }]
          : []
      )
  }
}

const wakeUp = (words: string): EndedChatTurn => ({
  selfStarted: true,
  lastAssistantMessage: words
})

describe('a background task wake-up answers the conversation whose turn left it running', () => {
  it('posts the wake-up turn to the thread, across a restart, and keeps it in Orca once another asker left other work', async () => {
    const t = harness()
    t.fromThread()
    t.run(['orca orchestration worker-start --spec fix'])
    await t.end({ lastAssistantMessage: 'Starting a worker.' }, 10)
    // Between turns only that work runs, so a worker it starts reports to the thread.
    expect(wokenForConversation(t.link(), null)).toBe(true)
    t.restart()
    await t.end(wakeUp('Still no worker: its worktree creation failed.'), 20)
    expect(t.said()).toEqual([
      { words: 'Starting a worker.', origin: 'delivery' },
      { words: 'Still no worker: its worktree creation failed.', origin: 'delivery' }
    ])

    // The owner asks in Orca (the mirror off) and that turn leaves other work running.
    t.fromThread()
    t.run(['sleep 60'])
    await t.end({ lastAssistantMessage: 'Waiting.' }, 30)
    t.askedInOrca()
    t.run(['sleep 60', 'pnpm build'])
    await t.end({}, 40)
    await t.end(wakeUp('Build finished.'), 50)
    expect(t.said().map(({ words }) => words)).not.toContain('Build finished.')
  })
})
