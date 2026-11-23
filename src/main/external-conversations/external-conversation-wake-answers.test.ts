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
import type { ConversationEvent } from './external-conversation-events'
import { recordAdmittedTurn } from './external-conversation-last-turn'
import { keepLinkFact } from './external-conversation-link-writes'
import { readLinks, type ExternalConversationLinkStore } from './external-conversation-links'
import { wokenRunningTurn } from './external-conversation-wake-answers'

// A Slack thread's turn starts a background task and ends; the task finishing wakes the chat in a turn
// that names its run. That turn answers the thread. A wake-up naming any run the thread's own turns
// didn't start (or naming nothing) stays in Orca, and so does one someone in Orca steered into.

const SESSION = 'chat-1'
const PANE = chatPaneKey(SESSION)
const FOLDER = 'bot-home'
const workspace = { worktreeId: folderWorkspaceKey(FOLDER), sshHostId: null }

type Child = Pick<
  AgentChildWorkView,
  'invocation' | 'kind' | 'state' | 'operation' | 'firstObservedAt'
>

/** A self-started turn's lifecycle row: its own item opened it, and it names what woke it. */
function wakeRow(at: number, wokenBy: string[]): { item: AgentJournalRenderItem } {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wake checks read only the item id and its turn body.
  const item = {
    itemId: `turn-${at}`,
    body: {
      kind: 'turn',
      turnId: `t-${at}`,
      state: 'running',
      startedAt: at,
      userItemId: `turn-${at}`,
      ...(wokenBy.length ? { wokenBy } : {})
    }
  } as Partial<AgentJournalRenderItem> as AgentJournalRenderItem
  return { item }
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
  const store = {
    getRepos: () => [],
    getWorktreeMeta: () => undefined,
    getFolderWorkspace: (id: string) => (id === FOLDER ? saved : undefined),
    updateFolderWorkspace: (_id: string, updates: { externalConversations?: unknown[] }) => {
      Object.assign(saved, updates)
    }
  } as Partial<ExternalConversationLinkStore> as ExternalConversationLinkStore
  const link = (): ExternalConversationLink => readLinks(store, workspace)[0]!
  const children: Child[] = []
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
  let wakeWrites = 0
  let audience = true
  const turns = () =>
    new ChatTurns({
      readHookRow: () => row(),
      linkedFor: () => ({ workspace, link: link() }),
      emit: (event) => events.push(event),
      childWork: () => children,
      runningTurnWoken: () => wokenRunningTurn(link(), active),
      keepWakeAnswers: (linked, wakeAnswers) => {
        wakeWrites += 1
        keepLinkFact(store, linked, { wakeAnswers })
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
      promptsAudience: () => audience,
      pendingPrompt: () => pending,
      turnOpener: () => null,
      keepAdoptedTurn: () => {},
      setTimer: () => ({ cancel: () => {} }),
      now: () => 1
    })
  let chat = turns()
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const run = (id: string) => ({ invocationId: id, generation: 1 })
  const start = (id: string, at: number) =>
    children.push({ invocation: run(id), kind: 'command', state: 'working', firstObservedAt: at })
  return {
    events,
    link,
    children,
    wakeWrites: () => wakeWrites,
    /** The connector service takes no Orca-raised turn's state. */
    noAudience: () => (audience = false),
    restart: () => (chat = turns()),
    /** The task running as `id` resumed as a new run. */
    resume(id: string, as: string) {
      Object.assign(
        children.find((child) => child.invocation.invocationId === id)!,
        {
          invocation: { invocationId: as, generation: 2 },
          state: 'working'
        }
      )
    },
    /** A turn from `at` to `at + 5`. `woke`: the run ids a self-started turn names. `late`: work a
     *  next turn starts while this end's journal read is still pending. */
    async turn(
      at: number,
      opts: {
        from?: 'thread'
        woke?: string[]
        started?: string[]
        says?: string
        steeredAt?: number
        late?: string[]
        prompt?: PendingPrompt
        /** Someone in Orca steers in while the end's journal read is pending. */
        steerDuringRead?: number
        /** Runs that finished into the wake-up after the thread was told it started. */
        absorbs?: string[]
        /** What else happens while the end's journal read is pending. */
        duringRead?: () => void
      }
    ) {
      leadStartedAt = at
      leadWorking = true
      active = opts.woke ? wakeRow(at, opts.woke) : null
      chat.observe(PANE)
      if (opts.prompt) {
        pending = opts.prompt
        chat.news({ kind: 'prompt', sessionId: SESSION })
        await flush()
      }
      if (opts.steeredAt !== undefined) {
        vi.spyOn(Date, 'now').mockReturnValue(opts.steeredAt)
        recordAdmittedTurn({ store }, orcaSteer)
      }
      opts.started?.forEach((id) => start(id, at + 1))
      if (opts.from === 'thread') {
        nextOrigin = 'delivery'
      }
      leadWorking = false
      active = null
      pending = null
      const wake = opts.woke
        ? {
            wake: {
              wokenBy: [...opts.woke, ...(opts.absorbs ?? [])],
              steered: opts.steeredAt !== undefined
            }
          }
        : {}
      const words = opts.says ? { lastAssistantMessage: opts.says } : {}
      chat.news({
        kind: 'turn-ended',
        sessionId: SESSION,
        outcome: 'success',
        at: at + 5,
        readTurn: async () => {
          opts.duringRead?.()
          if (opts.steerDuringRead !== undefined) {
            vi.spyOn(Date, 'now').mockReturnValue(opts.steerDuringRead)
            recordAdmittedTurn({ store }, orcaSteer)
          }
          return { ...wake, ...words }
        }
      })
      opts.late?.forEach((id) => start(id, at + 7))
      await flush()
    },
    finish(id: string) {
      Object.assign(
        children.find((child) => child.invocation.invocationId === id)!,
        { state: 'done' }
      )
    },
    said: () =>
      events.flatMap((event) =>
        event.kind === 'turn-ended' && event.lastAssistantMessage
          ? [event.lastAssistantMessage]
          : []
      )
  }
}

describe('a background task wake-up answers the conversation whose own turn started the task', () => {
  it('posts the thread task’s wake-up, across a restart, and never one naming a task Orca started', async () => {
    const t = harness()
    await t.turn(10, { started: ['private-build'] })
    await t.turn(20, { from: 'thread', started: ['worker-retry'], says: 'Retrying the worker.' })
    t.restart()
    t.finish('private-build')
    await t.turn(31, { woke: ['private-build'], says: 'Build finished.' })
    t.finish('worker-retry')
    await t.turn(41, {
      woke: ['worker-retry'],
      says: 'Still no worker: its worktree creation failed.'
    })
    expect(t.said()).toEqual([
      'Retrying the worker.',
      'Still no worker: its worktree creation failed.'
    ])
  })

  it('keeps in Orca a wake-up naming nothing, though a thread task finished meanwhile', async () => {
    const t = harness()
    await t.turn(10, { from: 'thread', started: ['worker-retry'], says: 'Retrying.' })
    t.finish('worker-retry')
    await t.turn(21, { woke: [], says: 'Scheduled check-in.' })
    expect(t.said()).toEqual(['Retrying.'])
  })

  it('takes back to Orca a wake-up someone in Orca steered into, though the thread saw it start', async () => {
    const t = harness()
    await t.turn(10, { from: 'thread', started: ['worker-retry'], says: 'Retrying.' })
    t.finish('worker-retry')
    await t.turn(21, {
      woke: ['worker-retry'],
      steeredAt: 23,
      started: ['steered-job'],
      says: 'Did it your way.'
    })
    expect(t.link().wakeAnswers).toBeUndefined()
    expect(t.events.filter((event) => event.kind === 'turn-started')).toHaveLength(1)
    expect(t.said()).toEqual(['Retrying.'])
  })

  it('never records a task from a thread turn steered from Orca, nor one a later turn started', async () => {
    const t = harness()
    await t.turn(10, { from: 'thread', steeredAt: 12, started: ['steered-job'], says: 'On it.' })
    t.finish('steered-job')
    await t.turn(21, { woke: ['steered-job'], says: 'Steered job done.' })
    await t.turn(30, { from: 'thread', says: 'Done here.', late: ['next-turn-job'] })
    t.finish('next-turn-job')
    await t.turn(41, { woke: ['next-turn-job'], says: 'Next turn job done.' })
    expect(t.said()).toEqual(['On it.', 'Done here.'])
  })

  it("tells the thread a wake-up's approval prompt and its final words", async () => {
    const t = harness()
    await t.turn(10, { from: 'thread', started: ['worker-retry'] })
    t.finish('worker-retry')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prompt path reads only its id here; its kind is shown as is.
    const approval = { promptId: 'p1', kind: 'approval' } as Partial<PendingPrompt> as PendingPrompt
    await t.turn(21, {
      woke: ['worker-retry'],
      prompt: approval,
      says: 'Worker started after approval.'
    })
    expect(t.events.map((event) => event.kind)).toContain('turn-started')
    expect(t.events.find((event) => event.kind === 'prompt')).toMatchObject({
      prompt: { raisedBy: 'conversation' }
    })
    expect(t.said()).toEqual(['Worker started after approval.'])
  })

  it('keeps in Orca the wake-up of a thread task that Orca resumed', async () => {
    const t = harness()
    await t.turn(10, { from: 'thread', started: ['agent-run-1'], says: 'Auditing.' })
    t.finish('agent-run-1')
    t.resume('agent-run-1', 'agent-run-2')
    await t.turn(21, { says: 'Resumed it here.' })
    expect(t.link().wakeAnswers).toBeUndefined()
    t.finish('agent-run-2')
    await t.turn(31, { woke: ['agent-run-2'], says: 'Audit done.' })
    expect(t.said()).toEqual(['Auditing.'])
  })

  it('tells the thread nothing of an Orca-only wake-up someone in Orca steered into', async () => {
    const t = harness()
    t.noAudience()
    await t.turn(10, { started: ['private-build'] })
    t.finish('private-build')
    await t.turn(21, { woke: ['private-build'], steeredAt: 23, says: 'Fixed the build.' })
    expect(t.events).toEqual([])
  })

  it('saves the record only when it changes', async () => {
    const t = harness()
    await t.turn(10, { from: 'thread', started: ['worker-retry'], says: 'Retrying.' })
    await t.turn(20, { says: 'Still here.' })
    await t.turn(30, { says: 'Still here.' })
    expect(t.wakeWrites()).toBe(1)
  })

  it('keeps a steer from Orca that lands while the end is read', async () => {
    const t = harness()
    await t.turn(10, {
      from: 'thread',
      started: ['steered-job'],
      steerDuringRead: 14,
      says: 'On it.'
    })
    expect(t.link().wakeAnswers).toBeUndefined()
  })

  it('ends in Orca a wake-up another run finished into, and records nothing it started', async () => {
    const t = harness()
    await t.turn(10, { from: 'thread', started: ['worker-retry'], says: 'Retrying.' })
    t.finish('worker-retry')
    await t.turn(21, {
      woke: ['worker-retry'],
      absorbs: ['private-build'],
      started: ['follow-up'],
      says: 'Build and worker both done.'
    })
    expect(t.said()).toEqual(['Retrying.'])
    expect(t.link().wakeAnswers).toBeUndefined()
  })

  it('never records a run resumed while the end is read', async () => {
    const t = harness()
    await t.turn(10, {
      from: 'thread',
      started: ['job-run-1'],
      says: 'Started.',
      duringRead: () => {
        t.finish('job-run-1')
        t.resume('job-run-1', 'job-run-2')
      }
    })
    expect(t.link().wakeAnswers).toBeUndefined()
  })
})
