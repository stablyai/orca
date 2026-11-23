import { describe, expect, it } from 'vitest'
import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ConnectorTurnOrigin } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { chatPaneKey } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import {
  endedTurn,
  WAKE_LAUNCH_WINDOW_MS,
  type EndedTurnLaunch
} from './external-conversation-ended-turn'
import type { ConversationChat } from './external-conversation-chat'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { ConversationEvent } from './external-conversation-events'
import { readLinks, type ExternalConversationLinkStore } from './external-conversation-links'

// A Slack thread's turn launches a background task and ends; the task finishing wakes the chat in a
// turn that names its run. That turn answers the thread only when every run it names was launched
// for the thread alone: every input its turn had taken at the launch was the thread's, as the
// launching turn's journal row recorded it.

const SESSION = 'chat-1'
const PANE = chatPaneKey(SESSION)
const FOLDER = 'bot-home'
const THREAD = { source: 'slack' as const, externalId: 'slack:T1:C1:1.2' }
const workspace = { worktreeId: folderWorkspaceKey(FOLDER), sshHostId: null }

/** A launch as the journal recorded it: each input send's sender, and the runs that woke the turn. */
type Launch = { run: string; sends?: ('thread' | 'orca')[]; runs?: string[] }

const ended = (launch: Launch, thread: Conversation): EndedTurnLaunch => ({
  run: launch.run,
  sends: (launch.sends ?? []).map((from) => (from === 'thread' ? thread : null)),
  runs: launch.runs ?? []
})

type Conversation = { source: ExternalConversationLink['source']; externalId: string }

function harness(thread: Conversation = THREAD) {
  let linkWrites = 0
  let workLinkReads = 0
  const saved: { externalConversations: unknown[] } = {
    externalConversations: [
      {
        ...thread,
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
      linkWrites += 1
      Object.assign(saved, updates)
    }
  } as Partial<ExternalConversationLinkStore> as ExternalConversationLinkStore
  const link = (): ExternalConversationLink => readLinks(store, workspace)[0]!
  let leadStartedAt = 0
  let leadWorking = false
  let nextOrigin: ConnectorTurnOrigin = 'local'
  let pending: PendingPrompt | null = null
  // The journal's launching rows: they outlive a restart of the watch.
  const journal: EndedTurnLaunch[] = []
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
      chatTurnOrigin: () => {
        const origin = nextOrigin
        nextOrigin = 'local'
        return origin
      },
      chatTurnDelivered: () => false,
      chatTurnDelivery: () => undefined,
      chatTurnWaiting: () => false,
      runningTurnReported: () => false,
      workLinks: async () => {
        workLinkReads += 1
        return []
      },
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
    linkWrites: () => linkWrites,
    workLinkReads: () => workLinkReads,
    restart: () => (chat = turns()),
    /** A turn from `at` to `at + 5`. `from: 'thread'`: a delivery opened or joined it. `woke`: the
     *  runs a self-started turn names at its start; `absorbs`: runs that then finished into it.
     *  `launches`: what its row records, which a later wake-up finds. `prompt`: raised mid-turn. */
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
        /** The watch restarted mid-turn, so it never saw the turn start. */
        unwatched?: true
      }
    ) {
      leadStartedAt = at
      leadWorking = true
      if (opts.unwatched) {
        chat = turns()
      } else {
        chat.observe(PANE)
      }
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
      const named = new Set(wokenBy)
      const found = journal.filter((launch) => named.has(launch.run))
      const wake = opts.woke
        ? { wake: { wokenBy, steered: opts.steered === true, launches: found } }
        : {}
      const words = opts.says ? { lastAssistantMessage: opts.says } : {}
      journal.push(...(opts.launches ?? []).map((launch) => ended(launch, thread)))
      chat.news({
        kind: 'turn-ended',
        sessionId: SESSION,
        outcome: 'success',
        at: at + 5,
        readTurn: async () => ({ ...wake, ...words, startedAt: at })
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
    // The launching rows are the record: the link is never written for it.
    expect(t.linkWrites()).toBe(0)
  })

  it('keeps in Orca a wake-up naming nothing, or a run whose launch wasn’t found', async () => {
    const t = harness()
    await t.turn(10, {
      from: 'thread',
      launches: [{ run: 'worker-retry', sends: ['thread'] }],
      says: 'Retrying.'
    })
    await t.turn(21, { woke: [], says: 'Scheduled check-in.' })
    await t.turn(31, { woke: ['older-run'], says: 'An older job finished.' })
    await t.turn(41, { woke: ['worker-retry', 'older-run'], says: 'Both finished.' })
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
    await t.turn(21, { woke: ['private-job'], says: 'Private job done.' })
    await t.turn(31, { woke: ['mixed-job'], says: 'Mixed job done.' })
    expect(t.said()).toEqual(['Joined.'])
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
    await t.turn(45, { woke: ['after-finish'], says: 'After-finish done.' })
    await t.turn(51, { woke: ['agent-run-2'], says: 'Resumed audit done.' })
    expect(t.said()).toEqual(['Auditing.', 'Audit done; checking once more.'])
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
      says: 'Build and worker both done.'
    })
    await t.turn(31, { woke: ['thread-build'], steered: true, says: 'Did it your way.' })
    expect(t.said()).toEqual(['Retrying.'])
  })

  it('places a wake-up whose start a restarted watch never saw by its own start, and no other end', async () => {
    const t = harness()
    await t.turn(10, { from: 'thread', launches: [{ run: 'worker-retry', sends: ['thread'] }] })
    await t.turn(21, { woke: ['worker-retry'], says: 'Worker started.', unwatched: true })
    expect(t.events.at(-1)).toMatchObject({
      kind: 'turn-ended',
      turnId: 21,
      lastAssistantMessage: 'Worker started.'
    })
    // Any other end a restarted watch never saw starting is placed as before: unplaced.
    await t.turn(30, { from: 'thread', says: 'Done.', unwatched: true })
    expect(t.events.at(-1)).toMatchObject({ kind: 'turn-ended', turnId: null })
  })

  it('shows the thread nothing of a wake-up while it runs, only its final words', async () => {
    // A Linear conversation, whose answers carry the work links its turns made.
    const t = harness({ source: 'linear', externalId: 'linear:issue-1' })
    await t.turn(10, {
      from: 'thread',
      launches: [{ run: 'worker-retry', sends: ['thread'] }],
      says: 'Retrying.'
    })
    const before = t.events.length
    const reads = t.workLinkReads()
    await t.turn(21, { woke: ['worker-retry'], says: 'Worker started.' })
    // Its words alone: no work links are looked up for it.
    expect(t.workLinkReads()).toBe(reads)
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

const row = (itemId: string, sequence: number, body: Record<string, unknown>) => ({
  itemId,
  sequence,
  revision: 0,
  observedAt: sequence,
  body
})
const said = (text: string, role = 'user') => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text }]
})

/** A chat whose journal answers the ended turn's own read with `ended`, and the wake-up's look back
 *  (anchored by time) with `back`, noting each anchor it was asked with. */
function journalChat(
  ended: unknown[],
  back: unknown[],
  cursor: { epoch: string; sequence: number },
  asked: Record<string, unknown>[] = [],
  backEpoch = cursor.epoch
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: endedTurn reads only these journal reads; the rows are journal-shaped.
  return {
    journalReads: async () => ({
      operationWindow: async (anchors: Record<string, unknown>) => {
        asked.push(anchors)
        return anchors.observedSince === undefined
          ? { snapshot: { items: ended, submissions: [], cursor } }
          : { snapshot: { items: back, submissions: [], cursor: { ...cursor, epoch: backEpoch } } }
      },
      canonicalItemIds: async () => new Map()
    })
  } as unknown as ConversationChat
}

it('finds a wake-up’s launches in the last day’s turns, reading each send’s conversation', async () => {
  const DAY = WAKE_LAUNCH_WINDOW_MS
  const delivered = (text: string, deliveryId: string) => ({
    ...said(text),
    connectorDelivery: { account: 'a', conversation: THREAD, deliveryId }
  })
  const wakeRow = row('wake-row', 6, {
    kind: 'turn',
    turnId: 't2',
    state: 'completed',
    startedAt: DAY + 50,
    userItemId: 'wake-row',
    wokenBy: ['r1', 'r2', 'r3']
  })
  const back = [
    row(agentJournalSubmissionKey('c1'), 1, {
      ...delivered('Retry the worker.', 'd1'),
      origin: 'connector'
    }),
    row(agentJournalSubmissionKey('c2'), 2, said('And the build.')),
    // The owner edited this queued delivery before it was sent: the edit drops its origin.
    row(agentJournalSubmissionKey('c3'), 3, delivered('Then deploy.', 'd3')),
    row('launching-row', 4, {
      kind: 'turn',
      turnId: 't1',
      state: 'completed',
      startedAt: DAY + 1,
      userItemId: agentJournalSubmissionKey('c1'),
      launches: [
        { run: 'r1', sends: ['c1'], runs: [] },
        { run: 'r2', sends: ['c1', 'c2'], runs: ['w1'] },
        { run: 'r3', sends: ['c3'], runs: [] },
        { run: 'unnamed', sends: ['c1'], runs: [] }
      ]
    }),
    wakeRow,
    // Written after the wake-up's end: not part of it.
    row('later-row', 7, {
      kind: 'turn',
      turnId: 't3',
      state: 'completed',
      startedAt: DAY + 60,
      userItemId: 'later-row',
      launches: [{ run: 'r1', sends: ['c2'], runs: [] }]
    })
  ]
  const cursor = { epoch: 'e', sequence: 6 }
  const asked: Record<string, unknown>[] = []
  const turn = await endedTurn(journalChat([wakeRow], back, cursor, asked), SESSION, 't2', cursor)
  expect(turn.wake?.launches).toEqual([
    { run: 'r1', sends: [THREAD], runs: [] },
    { run: 'r2', sends: [THREAD, null], runs: ['w1'] },
    { run: 'r3', sends: [null], runs: [] }
  ])
  expect(asked.at(-1)).toMatchObject({
    observedSince: 50,
    turnShape: true,
    withoutToolOutput: true
  })
  // A journal reset since the wake-up's end can't say: no launch is found.
  const reset = await endedTurn(
    journalChat([wakeRow], back, cursor, [], 'other'),
    SESSION,
    't2',
    cursor
  )
  expect(reset.wake?.launches).toEqual([])
})

it('gives a wake-up with no prose of its own no earlier answer to post', async () => {
  const items = [
    row('private-answer', 1, said('Private.', 'assistant')),
    row('wake-row', 2, {
      kind: 'turn',
      turnId: 't2',
      state: 'completed',
      startedAt: 2,
      userItemId: 'wake-row',
      wokenBy: ['r1']
    })
  ]
  const cursor = { epoch: 'e', sequence: 2 }
  const turn = await endedTurn(journalChat(items, [], cursor), SESSION, 't2', cursor)
  expect(turn.wake?.wokenBy).toEqual(['r1'])
  expect(turn.lastAssistantMessage).toBeUndefined()
})
