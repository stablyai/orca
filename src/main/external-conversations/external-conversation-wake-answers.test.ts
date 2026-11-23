import { describe, expect, it } from 'vitest'
import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ConnectorTurnOrigin } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { chatPaneKey } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import { endedTurn, type EndedTurnLaunch } from './external-conversation-ended-turn'
import type { ConversationChat } from './external-conversation-chat'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { ConversationEvent } from './external-conversation-events'
import { keepLinkFact } from './external-conversation-link-writes'
import { TurnEndRecords } from './external-conversation-wake-answers'
import { readLinks, type ExternalConversationLinkStore } from './external-conversation-links'

// A Slack thread's turn launches a background task and ends; the task finishing wakes the chat in a
// turn that names its run. That turn answers the thread only when every run it names was launched
// for the thread alone: every input its turn had taken at the launch was the thread's.

const SESSION = 'chat-1'
const PANE = chatPaneKey(SESSION)
const FOLDER = 'bot-home'
const THREAD = { source: 'slack' as const, externalId: 'slack:T1:C1:1.2' }
const workspace = { worktreeId: folderWorkspaceKey(FOLDER), sshHostId: null }

/** A launch as the journal recorded it: each input send's sender, and the runs that woke the turn. */
type Launch = { run: string; sends?: ('thread' | 'orca')[]; runs?: string[] }

const ended = (launch: Launch): EndedTurnLaunch => ({
  run: launch.run,
  sends: (launch.sends ?? []).map((from) => (from === 'thread' ? THREAD : null)),
  runs: launch.runs ?? []
})

function harness() {
  const saved: { externalConversations: unknown[] } = {
    externalConversations: [
      {
        ...THREAD,
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
  let leadStartedAt = 0
  let leadWorking = false
  let nextOrigin: ConnectorTurnOrigin = 'local'
  let pending: PendingPrompt | null = null
  let wakeWrites = 0
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
      promptsAudience: () => true,
      pendingPrompt: () => pending,
      turnOpener: () => null,
      keepAdoptedTurn: () => {},
      setTimer: () => ({ cancel: () => {} }),
      now: () => 1
    })
  let chat = turns()
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  return {
    events,
    link,
    wakeWrites: () => wakeWrites,
    restart: () => (chat = turns()),
    /** A turn from `at` to `at + 5`. `from: 'thread'`: a delivery opened or joined it. `woke`: the
     *  runs a self-started turn names at its start; `absorbs`: runs that then finished into it.
     *  `prompt`: raised mid-turn. */
    async turn(
      at: number,
      opts: {
        from?: 'thread'
        woke?: string[]
        absorbs?: string[]
        steered?: true
        launches?: Launch[]
        says?: string
        prompt?: PendingPrompt
        /** The end's journal read waits until `release` runs. */
        hold?: { release?: () => void }
      }
    ) {
      leadStartedAt = at
      leadWorking = true
      chat.observe(PANE)
      if (opts.prompt) {
        pending = opts.prompt
        chat.news({ kind: 'prompt', sessionId: SESSION })
        await flush()
      }
      if (opts.from === 'thread') {
        nextOrigin = 'delivery'
      }
      leadWorking = false
      pending = null
      const wokenBy = [...(opts.woke ?? []), ...(opts.absorbs ?? [])]
      const wake = opts.woke ? { wake: { wokenBy, steered: opts.steered === true } } : {}
      const words = opts.says ? { lastAssistantMessage: opts.says } : {}
      const launches = opts.launches ? { launches: opts.launches.map(ended) } : {}
      chat.news({
        kind: 'turn-ended',
        sessionId: SESSION,
        outcome: 'success',
        at: at + 5,
        readTurn: async () => {
          const hold = opts.hold
          if (hold) {
            await new Promise<void>((resolve) => (hold.release = resolve))
          }
          return { ...wake, ...words, ...launches }
        }
      })
      await flush()
    },
    said: () =>
      events.flatMap((event) =>
        event.kind === 'turn-ended' && event.lastAssistantMessage
          ? [event.lastAssistantMessage]
          : []
      ),
    prompts: () => events.flatMap((event) => (event.kind === 'prompt' ? [event.prompt] : []))
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prompt path reads only its id here; its kind is shown as is.
const approval = (promptId: string) => ({ promptId, kind: 'approval' }) as PendingPrompt

describe('a background run answers the conversation it was launched for', () => {
  it('posts the thread run’s wake-up, across a restart, and never one an Orca turn launched', async () => {
    const t = harness()
    await t.turn(10, { launches: [{ run: 'private-build', sends: ['orca'] }] })
    await t.turn(20, {
      from: 'thread',
      launches: [{ run: 'worker-retry', sends: ['thread'] }],
      says: 'Retrying the worker.'
    })
    t.restart()
    await t.turn(31, { woke: ['private-build'], says: 'Build finished.' })
    await t.turn(41, { woke: ['worker-retry'], says: 'Still no worker: its worktree failed.' })
    expect(t.said()).toEqual(['Retrying the worker.', 'Still no worker: its worktree failed.'])
  })

  it('keeps in Orca a wake-up naming nothing', async () => {
    const t = harness()
    await t.turn(10, {
      from: 'thread',
      launches: [{ run: 'worker-retry', sends: ['thread'] }],
      says: 'Retrying.'
    })
    await t.turn(21, { woke: [], says: 'Scheduled check-in.' })
    expect(t.said()).toEqual(['Retrying.'])
  })

  it('never gives the thread a run launched before it joined an Orca turn, or after', async () => {
    const t = harness()
    await t.turn(10, {
      from: 'thread',
      launches: [
        { run: 'private-job', sends: ['orca'] },
        { run: 'mixed-job', sends: ['orca', 'thread'] }
      ],
      says: 'Joined.'
    })
    expect(t.link().wakeAnswers).toBeUndefined()
    await t.turn(21, { woke: ['private-job'], says: 'Private job done.' })
    await t.turn(31, { woke: ['mixed-job'], says: 'Mixed job done.' })
    expect(t.said()).toEqual(['Joined.'])
  })

  it('records a thread run whatever it has done by the turn’s end', async () => {
    const t = harness()
    await t.turn(10, {
      from: 'thread',
      launches: [{ run: 'quick-job', sends: ['thread'] }],
      says: 'Started.'
    })
    expect(t.link().wakeAnswers).toEqual({ runs: ['quick-job'] })
  })

  it('keeps in Orca a wake-up’s follow-up run, and a resume launched from Orca', async () => {
    const t = harness()
    await t.turn(10, {
      from: 'thread',
      launches: [{ run: 'agent-run-1', sends: ['thread'] }],
      says: 'Auditing.'
    })
    await t.turn(21, {
      woke: ['agent-run-1'],
      launches: [{ run: 'follow-up', runs: ['agent-run-1'] }],
      says: 'Audit done; checking once more.'
    })
    await t.turn(25, {
      from: 'thread',
      launches: [{ run: 'after-finish', sends: ['thread'], runs: ['agent-run-1'] }]
    })
    await t.turn(31, { launches: [{ run: 'agent-run-2', sends: ['orca'] }] })
    await t.turn(41, { woke: ['follow-up'], says: 'Checked.' })
    await t.turn(51, { woke: ['agent-run-2'], says: 'Resumed audit done.' })
    expect(t.said()).toEqual(['Auditing.', 'Audit done; checking once more.'])
    expect(t.link().wakeAnswers).toEqual({ runs: ['agent-run-1'] })
  })

  it('ends in Orca a wake-up another run finished into, or one someone in Orca steered', async () => {
    const t = harness()
    await t.turn(10, {
      from: 'thread',
      launches: [
        { run: 'worker-retry', sends: ['thread'] },
        { run: 'thread-build', sends: ['thread'] }
      ],
      says: 'Retrying.'
    })
    await t.turn(21, {
      woke: ['worker-retry'],
      absorbs: ['private-build'],
      launches: [{ run: 'follow-up', runs: ['worker-retry', 'private-build'] }],
      says: 'Build and worker both done.'
    })
    await t.turn(31, { woke: ['thread-build'], steered: true, says: 'Did it your way.' })
    expect(t.said()).toEqual(['Retrying.'])
    expect(t.link().wakeAnswers?.runs).not.toContain('follow-up')
  })

  it('posts a quick wake-up whose launching turn’s end is still being read', async () => {
    const t = harness()
    const hold: { release?: () => void } = {}
    await t.turn(10, {
      from: 'thread',
      launches: [{ run: 'quick-job', sends: ['thread'] }],
      says: 'Started.',
      hold
    })
    await t.turn(21, { woke: ['quick-job'], says: 'Quick job done.' })
    hold.release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.said()).toEqual(['Started.', 'Quick job done.'])
  })

  it('saves the record only when a launch adds to it', async () => {
    const t = harness()
    await t.turn(10, {
      from: 'thread',
      launches: [{ run: 'worker-retry', sends: ['thread'] }],
      says: 'Retrying.'
    })
    await t.turn(20, { from: 'thread', says: 'Still here.' })
    await t.turn(30, { says: 'Still here.' })
    expect(t.wakeWrites()).toBe(1)
  })

  it('shows the thread nothing of a wake-up while it runs, only its final words', async () => {
    const t = harness()
    await t.turn(10, {
      from: 'thread',
      launches: [{ run: 'worker-retry', sends: ['thread'] }],
      says: 'Retrying.'
    })
    const before = t.events.length
    await t.turn(21, { woke: ['worker-retry'], says: 'Worker started.' })
    expect(t.events.slice(before)).toEqual([
      expect.objectContaining({
        kind: 'turn-ended',
        origin: 'delivery',
        lastAssistantMessage: 'Worker started.'
      })
    ])
  })

  it('raises a wake-up’s prompt as Orca’s, like any turn Orca began', async () => {
    const t = harness()
    await t.turn(10, {
      from: 'thread',
      launches: [{ run: 'worker-retry', sends: ['thread'] }],
      says: 'Retrying.'
    })
    await t.turn(21, { woke: ['worker-retry'], prompt: approval('p1'), says: 'Approved.' })
    expect(t.prompts().map((prompt) => prompt.raisedBy)).toEqual(['orca'])
    expect(t.said()).toEqual(['Retrying.'])
  })
})

it('reads each launch’s sends as the conversations that delivered them', async () => {
  const row = (itemId: string, sequence: number, body: Record<string, unknown>) => ({
    itemId,
    sequence,
    revision: 0,
    observedAt: sequence,
    body
  })
  const said = (text: string) => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })
  const items = [
    row(agentJournalSubmissionKey('c1'), 1, {
      ...said('Retry the worker.'),
      connectorDelivery: {
        account: 'a',
        conversation: THREAD,
        deliveryId: 'd1'
      }
    }),
    row(agentJournalSubmissionKey('c2'), 2, said('And the build.')),
    row('turn-row', 3, {
      kind: 'turn',
      turnId: 't1',
      state: 'completed',
      startedAt: 1,
      userItemId: agentJournalSubmissionKey('c1'),
      launches: [
        { run: 'r1', sends: ['c1'], runs: [] },
        { run: 'r2', sends: ['c1', 'c2'], runs: ['w1'] }
      ]
    })
  ]
  const cursor = { epoch: 'e', sequence: 3 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: endedTurn reads only these journal reads; the rows are journal-shaped.
  const chat = {
    journalReads: async () => ({
      operationWindow: async () => ({ snapshot: { items, submissions: [], cursor } }),
      canonicalItemIds: async () => new Map()
    })
  } as unknown as ConversationChat
  const turn = await endedTurn(chat, SESSION, 't1', cursor)
  expect(turn.launches).toEqual([
    { run: 'r1', sends: [THREAD], runs: [] },
    { run: 'r2', sends: [THREAD, null], runs: ['w1'] }
  ])
})

it('gives a wake-up with no prose of its own no earlier answer to post', async () => {
  const items = [
    {
      itemId: 'private-answer',
      sequence: 1,
      revision: 0,
      observedAt: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Private.' }] }
    },
    {
      itemId: 'wake-row',
      sequence: 2,
      revision: 0,
      observedAt: 2,
      body: {
        kind: 'turn',
        turnId: 't2',
        state: 'completed',
        startedAt: 2,
        userItemId: 'wake-row',
        wokenBy: ['r1']
      }
    }
  ]
  const cursor = { epoch: 'e', sequence: 2 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: endedTurn reads only these journal reads; the rows are journal-shaped.
  const chat = {
    journalReads: async () => ({
      operationWindow: async () => ({ snapshot: { items, submissions: [], cursor } }),
      canonicalItemIds: async () => new Map()
    })
  } as unknown as ConversationChat
  const turn = await endedTurn(chat, SESSION, 't2', cursor)
  expect(turn.wake?.wokenBy).toEqual(['r1'])
  expect(turn.lastAssistantMessage).toBeUndefined()
})

it('keeps no chat once its turn ends are read', async () => {
  const records = new TurnEndRecords()
  const reads = Array.from({ length: 100 }, (_, index) =>
    records.read(
      `pane-${index % 10}`,
      async () => index,
      () => {}
    )
  )
  await Promise.all(reads)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(records.pending).toBe(0)
})
