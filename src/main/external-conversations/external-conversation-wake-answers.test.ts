import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentChildWorkView } from '../../shared/agent-status/child-work/agent-status-child-work-view'
import type { ConnectorTurnOrigin } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { AdmittedMessage } from '../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { chatPaneKey } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import type { EndedChatTurn } from './external-conversation-ended-turn'
import type { ConversationEvent } from './external-conversation-events'
import { recordAdmittedTurn } from './external-conversation-last-turn'
import { keepLinkFact } from './external-conversation-link-writes'
import { readLinks, type ExternalConversationLinkStore } from './external-conversation-links'
import { onlyConversationTasksRun, wokenRunningTurn } from './external-conversation-wake-answers'

// A Slack thread's turn starts a background task and ends; the task finishing wakes the chat in a turn
// no one typed. That turn answers the thread. A task an Orca-typed turn started never does, and someone
// in Orca steering into the wake-up takes what follows back to Orca.

const SESSION = 'chat-1'
const PANE = chatPaneKey(SESSION)
const FOLDER = 'bot-home'
const workspace = { worktreeId: folderWorkspaceKey(FOLDER), sshHostId: null }

type Task = Pick<
  AgentChildWorkView,
  'id' | 'kind' | 'state' | 'operation' | 'firstObservedAt' | 'observedAt' | 'settledAt'
>

/** A self-started turn's lifecycle row: its own item opened it. */
function wakeRow(at: number): { item: Pick<AgentJournalRenderItem, 'itemId' | 'body'> } {
  return {
    item: {
      itemId: `turn-${at}`,
      body: {
        kind: 'turn',
        turnId: `t-${at}`,
        state: 'running',
        startedAt: at,
        userItemId: `turn-${at}`
      }
    }
  }
}

/** Someone in Orca steering a message into the running turn. */
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recordAdmittedTurn reads only these fields.
const orcaSteer = {
  sessionId: SESSION,
  workspaceId: workspace.worktreeId,
  joinsRunningTurn: true,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'do it my way' }] }
} as Partial<AdmittedMessage> as AdmittedMessage

afterEach(() => vi.restoreAllMocks())

function harness() {
  const saved: { externalConversations: unknown[] } = {
    externalConversations: [
      {
        source: 'slack',
        externalId: 'slack:T1:C1:1.2',
        sessionId: SESSION,
        agent: 'claude',
        paneKey: PANE,
        bot: { kind: 'bot', botId: 'bot-1' },
        lastTurn: 'conversation',
        createdAt: 1
      } satisfies ExternalConversationLink
    ]
  }
  // The real link writers over one folder workspace's saved record.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the link writers call only these store members for a folder workspace.
  const store: ExternalConversationLinkStore = {
    getRepos: () => [],
    getWorktreeMeta: () => undefined,
    getFolderWorkspace: (id: string) => (id === FOLDER ? saved : undefined),
    updateFolderWorkspace: (_id: string, updates: { externalConversations?: unknown[] }) => {
      Object.assign(saved, updates)
    }
  } as Partial<ExternalConversationLinkStore> as ExternalConversationLinkStore
  const link = (): ExternalConversationLink => readLinks(store, workspace)[0]!
  const tasks: Task[] = []
  let active: ReturnType<typeof wakeRow> | null = null
  let leadStartedAt = 0
  let leadWorking = false
  let nextOrigin: ConnectorTurnOrigin = 'local'
  let pending: PendingPrompt | null = null
  const events: ConversationEvent[] = []
  const row = (): AgentStatusIpcPayload => ({
    paneKey: PANE,
    structuredHost: 'owned',
    state: leadWorking ? 'working' : 'done',
    mainAgent: { state: leadWorking ? 'working' : 'done', stateStartedAt: leadStartedAt },
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: leadStartedAt,
    prompt: ''
  })
  const turns = () =>
    new ChatTurns({
      readHookRow: () => row(),
      linkedFor: () => ({ workspace, link: link() }),
      emit: (event) => events.push(event),
      childWork: () => tasks,
      runningTurnWoken: () => wokenRunningTurn(link(), active, tasks),
      keepWakeAnswers: (linked, wakeAnswers) => keepLinkFact(store, linked, { wakeAnswers }),
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
      promptsAudience: () => true,
      pendingPrompt: () => pending,
      turnOpener: () => null,
      keepAdoptedTurn: () => {},
      setTimer: () => ({ cancel: () => {} }),
      now: () => 1
    })
  let chat = turns()
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const begin = (at: number, wake: boolean) => {
    leadStartedAt = at
    leadWorking = true
    active = wake ? wakeRow(at) : null
    chat.observe(PANE)
  }
  const start = (id: string, at: number) =>
    tasks.push({ id, kind: 'command', state: 'working', firstObservedAt: at, observedAt: at })
  /** `late`: tasks a next turn starts while this end's journal read is still pending. */
  const end = async (at: number, turn: EndedChatTurn, late: string[] = []) => {
    leadWorking = false
    active = null
    pending = null
    chat.news({
      kind: 'turn-ended',
      sessionId: SESSION,
      outcome: 'success',
      at,
      readTurn: async () => turn
    })
    late.forEach((id) => start(id, at + 2))
    await flush()
  }
  return {
    events,
    store,
    link,
    tasks,
    restart: () => (chat = turns()),
    /** A turn from `at` to `at + 5` that starts `started` background tasks. */
    async turn(
      at: number,
      opts: {
        from?: 'thread'
        wake?: boolean
        started?: string[]
        says?: string
        steeredAt?: number
        late?: string[]
      }
    ) {
      begin(at, opts.wake === true)
      if (opts.steeredAt !== undefined) {
        vi.spyOn(Date, 'now').mockReturnValue(opts.steeredAt)
        recordAdmittedTurn({ store }, orcaSteer)
      }
      for (const id of opts.started ?? []) {
        start(id, at + 1)
      }
      if (opts.from === 'thread') {
        nextOrigin = 'delivery'
      }
      await end(
        at + 5,
        {
          ...(opts.wake ? { selfStarted: true as const } : {}),
          ...(opts.says ? { lastAssistantMessage: opts.says } : {})
        },
        opts.late
      )
    },
    finish(id: string, at: number) {
      Object.assign(
        tasks.find((task) => task.id === id)!,
        { state: 'done', settledAt: at, observedAt: at }
      )
    },
    async wakeAsks(at: number, prompt: PendingPrompt) {
      begin(at, true)
      pending = prompt
      chat.news({ kind: 'prompt', sessionId: SESSION })
      await flush()
    },
    wakeEnds: (at: number, says: string) =>
      end(at, { selfStarted: true, lastAssistantMessage: says }),
    running: (at: number) => wokenRunningTurn(link(), wakeRow(at), tasks),
    said: () =>
      events.flatMap((event) =>
        event.kind === 'turn-ended' && event.lastAssistantMessage
          ? [event.lastAssistantMessage]
          : []
      )
  }
}

describe('a background task wake-up answers the conversation whose own turn started the task', () => {
  it("posts the thread task's wake-up, across a restart, and never one for a task Orca's turn started", async () => {
    const t = harness()
    await t.turn(10, { started: ['private-build'] })
    await t.turn(20, { from: 'thread', started: ['worker-retry'], says: 'Retrying the worker.' })
    // Between turns the private build still runs, so a worker-start can't be told to be the thread's.
    expect(onlyConversationTasksRun(t.link(), t.tasks)).toBe(false)
    t.restart()
    t.finish('private-build', 30)
    await t.turn(31, { wake: true, says: 'Build finished.' })
    expect(onlyConversationTasksRun(t.link(), t.tasks)).toBe(true)
    t.finish('worker-retry', 40)
    await t.turn(41, { wake: true, says: 'Still no worker: its worktree creation failed.' })
    expect(t.said()).toEqual([
      'Retrying the worker.',
      'Still no worker: its worktree creation failed.'
    ])
  })

  it('stops answering the thread once someone in Orca steers into the wake-up', async () => {
    const t = harness()
    await t.turn(10, { from: 'thread', started: ['worker-retry'], says: 'Retrying.' })
    t.finish('worker-retry', 20)
    expect(t.running(21)).toBe(true)
    recordAdmittedTurn({ store: t.store }, orcaSteer)
    expect(t.running(21)).toBe(false)
  })

  it("tells the thread a wake-up's approval prompt and its final words", async () => {
    const t = harness()
    await t.turn(10, { from: 'thread', started: ['worker-retry'] })
    t.finish('worker-retry', 20)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prompt path reads only its id here; its kind is shown as is.
    await t.wakeAsks(21, {
      promptId: 'p1',
      kind: 'approval'
    } as Partial<PendingPrompt> as PendingPrompt)
    await t.wakeEnds(30, 'Worker started after approval.')
    expect(t.events.map((event) => event.kind)).toContain('turn-started')
    expect(t.events.find((event) => event.kind === 'prompt')).toMatchObject({
      prompt: { raisedBy: 'conversation' }
    })
    expect(t.said()).toEqual(['Worker started after approval.'])
  })

  it('never records a task from a thread turn someone in Orca steered into, nor one a later turn started', async () => {
    const t = harness()
    await t.turn(10, { from: 'thread', steeredAt: 12, started: ['steered-job'], says: 'On it.' })
    t.finish('steered-job', 20)
    await t.turn(21, { wake: true, says: 'Steered job done.' })
    await t.turn(30, { from: 'thread', says: 'Done here.', late: ['next-turn-job'] })
    t.finish('next-turn-job', 40)
    await t.turn(41, { wake: true, says: 'Next turn job done.' })
    expect(t.said()).toEqual(['On it.', 'Done here.'])
  })
})
