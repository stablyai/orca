// A Claude subagent's permission request, replayed from a capture of the real CLI through the real
// adapter, deferred sink, durable journal and status feed, published as production publishes it:
// on the sink's own publish, on a journal commit (a microtask later), and after child work. At every
// status publish the subagents read waiting must each have a pending card in that same journal, and
// the parent row must match a second host fed the same evidence with no subagent ever waiting: a
// subagent's wait never reaches its parent's row. Both hosts read the same journal, so what the
// prompt rows' linkage changes on the parent (its dating) is pinned where it shows.

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalProducerLinkage,
  AgentJournalRenderItem,
  AgentJournalResolution
} from '../../shared/agent-session-journal-types'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { AgentStatusStructuredSessionSubject } from '../../shared/agent-status-subject'
import { AgentHookServer } from '../agent-hooks/server'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { settleStructuredAgentSessionDeadGeneration } from '../native-chat/agent-session-wire/structured-agent-session-dead-generation-settlement'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import { indexedStatusFeedSession } from '../native-chat/agent-session-wire/structured-agent-session-status-feed-test-session'
import { invokeCanUseTool } from './claude-can-use-tool-test-support'
import { system, toolUse } from './claude-child-work-producer-harness.test-fixture'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  claudeStartupSettled
} from './claude-structured-session-test-support'

const SESSION = 'session-1'
const FENCE = 7

type Captured = { from: 'cli' | 'orca'; frame: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function captured(name: string): Captured[] {
  const path = join(__dirname, '__fixtures__', 'claude-subagent-permission-frames.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const events = isRecord(parsed) && isRecord(parsed.scenarios) ? parsed.scenarios[name] : null
  if (!Array.isArray(events)) {
    throw new Error(`no captured scenario ${name}`)
  }
  return events.flatMap((event) =>
    isRecord(event) && (event.from === 'cli' || event.from === 'orca') && isRecord(event.frame)
      ? [{ from: event.from, frame: event.frame }]
      : []
  )
}

/** The subagent that asks in a capture. */
function askerOf(name: string): string {
  return text(captured(name).find((event) => event.frame.subtype === 'task_started')?.frame.task_id)
}

const ASKER = askerOf('fg-allow')

/** The same evidence from a producer that never reads a subagent waiting. */
function withoutWaits(evidence: AgentChildWorkEvidence[]): AgentChildWorkEvidence[] {
  return evidence.map((edge) =>
    edge.type === 'live' && edge.child.state === 'waiting'
      ? { ...edge, child: { ...edge.child, state: 'working' } }
      : edge
  )
}

function parentRow(server: AgentHookServer) {
  const row = server.getStatusSnapshot()[0]
  return (
    row && {
      state: row.state,
      workingMode: row.workingMode,
      mainAgent: row.mainAgent,
      stateStartedAt: row.stateStartedAt
    }
  )
}

function pendingCards(items: readonly AgentJournalRenderItem[]): AgentJournalRenderItem[] {
  return items.filter(
    (item) =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
  )
}

const journals = createTrackedJournalOpener()
let root: string
/** What the host does with the adapter's events, where a test needs it. */
const hooks: { onEvent?: (event: ClaudeStructuredSessionEvent) => void } = {}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-subagent-request-'))
})

afterEach(async () => {
  hooks.onEvent = undefined
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** One status publish: what the parent row read beside the main-equivalent host, and whether a
 *  subagent read waiting without a pending card of its own in the journal it was projected from. */
type Publish = { waiting: string[]; askers: string[]; row: unknown; unwaited: unknown }

async function pipeline() {
  let clock = 1_700_000_000_000
  const now = () => (clock += 1)
  const journal: AgentSessionJournal = await journals.open({
    identity: identityFor(SESSION),
    now,
    stateDirectory: join(root, SESSION)
  })
  const server = new AgentHookServer()
  const unwaited = new AgentHookServer()
  const publishes: Publish[] = []
  let published: AgentStatusStructuredSessionSubject | undefined
  /** The child's row as the host shows it, which every surface reads. */
  const viewOf = (providerId: string) =>
    published &&
    server.getStructuredChildWorkViews(published).find((view) => view.providerId === providerId)
  const record = (subject: AgentStatusStructuredSessionSubject): void => {
    published = subject
    const cards = pendingCards(journal.snapshot().items)
    publishes.push({
      waiting: server
        .getStructuredChildWorkViews(subject)
        .flatMap((view) =>
          view.state === 'waiting' && view.membership === 'live' ? [view.providerId ?? '?'] : []
        ),
      askers: cards.flatMap((card) => (card.agentId ? [card.agentId] : [])),
      row: parentRow(server),
      unwaited: parentRow(unwaited)
    })
  }
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([
      [
        SESSION,
        indexedStatusFeedSession({
          journal,
          child: { generation: 'spawn-9', fence: FENCE, phase: 'ready' },
          provider: 'claude'
        })
      ]
    ]),
    getRecord: () => null,
    now,
    statusSink: () => ({
      publish: (summary, subject) => {
        server.ingestStructuredStatus(summary, subject)
        unwaited.ingestStructuredStatus(summary, subject)
        record(subject)
      },
      forget: (subject) => {
        server.dropStructuredStatus(subject)
        unwaited.dropStructuredStatus(subject)
      },
      publishChildWork: (subject, evidence, provider) => {
        server.ingestStructuredChildWork(subject, evidence, provider)
        unwaited.ingestStructuredChildWork(subject, withoutWaits(evidence), provider)
      },
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
    })
  })
  // As the host publishes: the sink's own publish, and every journal commit a microtask later.
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging(SESSION))
  const publishStatus = () => feed.publish(SESSION, journal)
  const target = { journal, fence: FENCE, publish: publishStatus }
  deferred.bind(target)
  let queued = false
  journal.observeCommits(() => {
    if (!queued) {
      queued = true
      queueMicrotask(() => {
        queued = false
        feed.publish(SESSION, journal)
      })
    }
  })
  const claude = fakeClaude()
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now,
    persistHandle: async () => {},
    onChildWorkEvidence: (sessionId, evidence) => feed.publishChildWork(sessionId, evidence),
    onEvent: (event) => hooks.onEvent?.(event)
  })
  await adapter.acquire({
    identity: identityFor(SESSION),
    fence: FENCE,
    spawnToken: 'spawn-9',
    events: deferred.sink
  })
  await claudeStartupSettled(adapter, SESSION)
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      expect(await deferred.drained()).toEqual({ ok: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  /** What the host's own commit writes for the card: its resolution, at the live turn. */
  const hostRecords =
    (resolution: Pick<AgentJournalResolution, 'state' | 'selectedOptionId'>, itemId = cardId()) =>
    async (): Promise<void> => {
      await deferred.drained()
      const card = pendingCards(journal.snapshot().items).find((item) => item.itemId === itemId)
      const identity = card && parseAgentJournalItemKey(card.itemId)
      if (card?.body.kind !== 'approval' || !identity) {
        throw new Error('no pending card to record')
      }
      await journal.appendItem(
        identity,
        { ...card.body, resolution: { ...resolution, resolvedBy: 'client-1', resolvedAt: now() } },
        { fence: FENCE, turnScope: journal.liveTurnScope() }
      )
    }
  const cardId = (): string => {
    const card = pendingCards(journal.snapshot().items)[0]
    if (!card) {
      throw new Error('no pending card')
    }
    return card.itemId
  }
  const connection = claude.connections[0]!
  const aborts = new Map<string, AbortController>()
  /** Feeds a captured frame as the CLI or the SDK hands it over, then lets every write land. The
   *  SDK hands `canUseTool` no agent id when `withoutAgentId`, as when the CLI names none. */
  const step = async (
    { from, frame }: Captured,
    options: { withoutAgentId?: boolean } = {}
  ): Promise<void> => {
    const request = isRecord(frame.request) ? frame.request : null
    if (frame.type === 'control_request' && request?.subtype === 'can_use_tool') {
      const controller = new AbortController()
      aborts.set(text(frame.request_id), controller)
      const agentId = options.withoutAgentId ? '' : text(request.agent_id)
      invokeCanUseTool(
        connection,
        text(request.tool_name),
        text(frame.request_id),
        text(request.tool_use_id),
        {
          input: isRecord(request.input) ? request.input : {},
          signal: controller.signal,
          ...(agentId ? { agentID: agentId } : {})
        }
      )
    } else if (from === 'cli') {
      connection.handlers.onMessage?.({ ...frame, session_id: PROVIDER_SESSION_ID })
    }
    await settle()
  }
  /** Replays a capture up to and including its permission request. */
  const ask = async (name: string, options: { withoutAgentId?: boolean } = {}): Promise<void> => {
    const events = captured(name)
    const at = events.findIndex((event) => event.frame.type === 'control_request')
    for (const event of events.slice(0, at + 1)) {
      await step(event, options)
    }
  }
  /** Publishes that broke the invariant or told the parent rows apart. */
  const violations = () =>
    publishes.filter(
      (entry) =>
        entry.waiting.some((id) => !entry.askers.includes(id)) ||
        !isDeepStrictEqual(entry.row, entry.unwaited)
    )
  /** Raises a request the capture does not hold, as the SDK would. */
  const raise = (requestId: string, toolUseId: string, agentId?: string): void => {
    const controller = new AbortController()
    aborts.set(requestId, controller)
    invokeCanUseTool(connection, 'Bash', requestId, toolUseId, {
      input: { command: `echo ${requestId}` },
      signal: controller.signal,
      ...(agentId ? { agentID: agentId } : {})
    })
  }
  return {
    adapter,
    journal,
    deferred,
    target,
    publishStatus,
    connection,
    now,
    raise,
    publishes,
    violations,
    viewOf,
    settle,
    step,
    ask,
    cardId,
    hostRecords,
    aborts
  }
}

type Pipeline = Awaited<ReturnType<typeof pipeline>>

function answer(
  run: Pipeline,
  optionId: 'allow' | 'deny',
  commit = run.hostRecords({ state: 'resolved', selectedOptionId: optionId }),
  itemId = run.cardId()
) {
  return run.adapter.answerPrompt({
    sessionId: SESSION,
    itemId,
    kind: 'approval',
    response: { kind: 'option', optionId },
    fence: FENCE,
    commit
  })
}

/** The user closes the card without answering; the Stop that follows ends the request. */
function dismiss(run: Pipeline) {
  return run.adapter.dismissPrompt({
    sessionId: SESSION,
    itemId: run.cardId(),
    fence: FENCE,
    answer: false,
    commit: run.hostRecords({ state: 'cancelled', selectedOptionId: null })
  })
}

/** Replays a whole capture, answering through the app's own path where Orca answered, and returns
 *  the asking subagent's row after each event, labelled. */
async function replay(name: string): Promise<Pipeline & { timeline: string[] }> {
  const run = await pipeline()
  const timeline: string[] = []
  for (const event of captured(name)) {
    const response = isRecord(event.frame.response) ? event.frame.response : null
    const request = isRecord(event.frame.request) ? event.frame.request : null
    let label = text(event.frame.subtype) || text(event.frame.type)
    if (event.from === 'orca' && event.frame.type === 'control_response' && response) {
      const behavior = isRecord(response.response) ? text(response.response.behavior) : ''
      await answer(run, behavior === 'deny' ? 'deny' : 'allow')
      await run.settle()
      label = behavior
    } else {
      await run.step(event)
      label = request?.subtype === 'can_use_tool' ? 'can_use_tool' : label
    }
    const view = run.viewOf(askerOf(name))
    timeline.push(`${label} -> ${view ? `${view.membership} ${view.state}` : 'none'}`)
  }
  return { ...run, timeline }
}

/** Root spawns agent-a, which spawns agent-n; `asker` asks for agent-n's Bash call, which is read
 *  after the request unless `toolCallFirst`. */
async function nested(asker: string, toolCallFirst = false): Promise<Pipeline> {
  const run = await pipeline()
  const spawn = (id: string, taskId: string, parentRef: string | null) => [
    toolUse(id, 'Agent', { description: taskId, prompt: 'go' }, parentRef),
    system('task_started', {
      task_id: taskId,
      tool_use_id: id,
      description: taskId,
      task_type: 'local_agent'
    })
  ]
  const bash = toolUse('toolu_bash_n', 'Bash', { command: 'touch n' }, 'toolu_n')
  for (const frame of [
    ...spawn('toolu_a', 'agent-a', null),
    ...spawn('toolu_n', 'agent-n', 'toolu_a'),
    ...(toolCallFirst ? [bash] : [])
  ]) {
    await run.step({ from: 'cli', frame })
  }
  run.raise('req-n', 'toolu_bash_n', asker)
  await run.step({
    from: 'cli',
    frame: toolUse('toolu_read_n', 'Read', { file_path: 'n' }, 'toolu_n')
  })
  return run
}

function linkageOf(item: AgentJournalProducerLinkage | undefined) {
  return {
    agentId: item?.agentId,
    parentAgentId: item?.parentAgentId,
    providerParentRef: item?.providerParentRef,
    producerKind: item?.producerKind,
    attempt: item?.attempt
  }
}

describe("a Claude subagent's permission request", () => {
  it.each([
    [
      'fg-allow',
      [
        'session_state_changed -> live working',
        'can_use_tool -> live waiting',
        'allow -> live working'
      ]
    ],
    // The parent's own turn ends while its background subagent is still asking.
    [
      'bg-allow',
      [
        'session_state_changed -> live working',
        'can_use_tool -> live waiting',
        'assistant -> live waiting',
        'success -> live waiting',
        'allow -> live working'
      ]
    ]
  ])(
    'waits from its request until answered, beside its card, the parent row as before (%s)',
    async (name, around) => {
      const run = await replay(name)
      const at = run.timeline.indexOf('can_use_tool -> live waiting')
      expect(run.timeline.slice(at - 1, at - 1 + around.length)).toEqual(around)
      expect(run.violations()).toEqual([])
    }
  )

  it('reads blocked as soon as the request arrives, dated by its card', async () => {
    const run = await pipeline()
    await run.ask('fg-allow')
    const card = pendingCards(run.journal.snapshot().items)[0]
    expect(run.publishes.at(-1)).toMatchObject({
      waiting: [card?.agentId],
      row: {
        state: 'blocked',
        stateStartedAt: card?.observedAt,
        mainAgent: { state: 'blocked', stateStartedAt: card?.observedAt }
      }
    })
    expect(run.viewOf(ASKER)?.operation).toMatchObject({ toolName: 'Bash' })
    expect(run.violations()).toEqual([])
  })

  it('waits only once its card is written, though the write waits for the journal', async () => {
    const run = await pipeline()
    const events = captured('fg-allow')
    const at = events.findIndex((event) => event.frame.type === 'control_request')
    for (const event of events.slice(0, at)) {
      await run.step(event)
    }
    // No journal is bound: the card's row waits in the sink while the host publishes.
    run.deferred.unbind()
    run.raise('req-late', 'toolu_late', ASKER)
    await new Promise((resolve) => setTimeout(resolve, 0))
    run.publishStatus()
    expect(run.publishes.at(-1)?.waiting).toEqual([])
    run.deferred.bind(run.target)
    await run.settle()
    expect(run.publishes.at(-1)?.waiting).toEqual([ASKER])
    expect(run.violations()).toEqual([])
  })

  it.each(['allowed', 'denied', 'dismissed and left to the Stop', 'withdrawn by Claude'] as const)(
    'frees the subagent when its request is %s',
    async (how) => {
      const run = await pipeline()
      await run.ask('fg-allow')
      if (how === 'allowed' || how === 'denied') {
        await answer(run, how === 'allowed' ? 'allow' : 'deny')
      } else if (how === 'dismissed and left to the Stop') {
        await dismiss(run)
      }
      await run.settle()
      // Claude withdraws the request itself; after a dismissal that closes nothing more.
      if (how !== 'allowed' && how !== 'denied') {
        for (const controller of run.aborts.values()) {
          controller.abort()
        }
        await run.settle()
      }
      expect(run.publishes.at(-1)?.waiting).toEqual([])
      expect(run.violations()).toEqual([])
    }
  )

  it('waits again, beside its card, when the host fails to record the answer', async () => {
    const run = await pipeline()
    await run.ask('fg-allow')
    await expect(
      answer(run, 'allow', async () => {
        throw new Error('journal write failed')
      })
    ).rejects.toThrow('journal write failed')
    await run.settle()
    expect(run.publishes.at(-1)?.waiting).toEqual([ASKER])
    expect(run.violations()).toEqual([])
  })

  it('keeps an answered request in the rows of the subagent that asked', async () => {
    const run = await replay('fg-allow')
    const card = run.journal.snapshot().items.find((item) => item.body.kind === 'approval')
    expect(card?.agentId).toBe(ASKER)
    expect(card?.body).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'allow' }
    })
  })

  it('names the subagent through the tool call it gates when the CLI does not', async () => {
    const run = await pipeline()
    await run.ask('fg-allow', { withoutAgentId: true })
    expect(pendingCards(run.journal.snapshot().items)[0]?.agentId).toBe(ASKER)
    expect(run.publishes.at(-1)?.waiting).toEqual([ASKER])
    expect(run.violations()).toEqual([])
  })

  it("gives a nested subagent's request the linkage its own rows carry", async () => {
    const run = await nested('agent-n')
    const items = run.journal.snapshot().items
    const card = items.find((item) => item.body.kind === 'approval')
    const sibling = items.find(
      (item) => item.body.kind === 'tool-call' && item.agentId === 'agent-n'
    )
    expect(linkageOf(card)).toEqual(linkageOf(sibling))
    expect(card).toMatchObject({ agentId: 'agent-n', parentAgentId: 'agent-a' })
  })

  it("files the request under the agent the CLI names when the gated call is another's", async () => {
    const run = await nested('agent-a', true)
    const items = run.journal.snapshot().items
    const card = items.find((item) => item.body.kind === 'approval')
    const askerRow = items.find(
      (item) => item.body.kind === 'tool-call' && item.agentId === 'agent-a'
    )
    expect(linkageOf(card)).toEqual(linkageOf(askerRow))
  })

  it('waits each asking subagent beside its own card, and only those', async () => {
    const run = await pipeline()
    await run.ask('fg-allow')
    const started = captured('fg-allow').find((event) => event.frame.subtype === 'task_started')
    await run.step({
      from: 'cli',
      frame: { ...started?.frame, task_id: 'agent-two', uuid: 'u-two', tool_use_id: 'toolu_two' }
    })
    run.raise('req-two', 'toolu_two_bash', 'agent-two')
    await run.settle()
    expect([...(run.publishes.at(-1)?.waiting ?? [])].sort()).toEqual([ASKER, 'agent-two'].sort())
    const cardOf = (agentId: string) =>
      pendingCards(run.journal.snapshot().items).find((card) => card.agentId === agentId)?.itemId
    const first = cardOf(ASKER)
    await answer(
      run,
      'allow',
      run.hostRecords({ state: 'resolved', selectedOptionId: 'allow' }, first),
      first
    )
    await run.settle()
    expect(run.publishes.at(-1)?.waiting).toEqual(['agent-two'])
    const second = cardOf('agent-two')
    await answer(
      run,
      'allow',
      run.hostRecords({ state: 'resolved', selectedOptionId: 'allow' }, second),
      second
    )
    await run.settle()
    expect(run.publishes.at(-1)?.waiting).toEqual([])
    expect(run.violations()).toEqual([])
  })

  it("stays blocked on the session's own request after its subagent's is answered", async () => {
    const run = await pipeline()
    await run.ask('fg-allow')
    run.raise('req-main', 'toolu_main_bash')
    await run.settle()
    const cards = pendingCards(run.journal.snapshot().items)
    expect(cards.map((card) => card.agentId ?? null).sort()).toEqual([ASKER, null].sort())
    // Dated by the session's own ask, though its subagent asked first: main's rule, as for Codex.
    const own = cards.find((card) => !card.agentId)?.observedAt
    expect(own).toBeGreaterThan(
      cards.find((card) => card.agentId === ASKER)?.observedAt ?? Infinity
    )
    expect(run.publishes.at(-1)).toMatchObject({
      waiting: [ASKER],
      row: { state: 'blocked', stateStartedAt: own, mainAgent: { stateStartedAt: own } }
    })
    const subagents = cards.find((card) => card.agentId === ASKER)?.itemId
    await answer(
      run,
      'allow',
      run.hostRecords({ state: 'resolved', selectedOptionId: 'allow' }, subagents),
      subagents
    )
    await run.settle()
    expect(run.publishes.at(-1)).toMatchObject({ waiting: [], row: { state: 'blocked' } })
    expect(run.violations()).toEqual([])
  })

  it('stops the subagent waiting when the process dies mid-request', async () => {
    const run = await pipeline()
    await run.ask('fg-allow')
    expect(run.publishes.at(-1)?.waiting).toEqual([ASKER])
    let settled: Promise<unknown> | undefined
    hooks.onEvent = (event) => {
      if (event.type === 'ended') {
        settled = settleStructuredAgentSessionDeadGeneration({
          journal: run.journal,
          sessionId: SESSION,
          fence: FENCE,
          settlementId: 'provider-exit:test',
          verdict: { state: 'interrupted', completedAt: run.now() },
          pendingSubmissionReason: 'provider_exited_before_acknowledgement'
        })
      }
    }
    run.connection.handlers.onExit?.(new Error('claude crashed'))
    for (let attempt = 0; attempt < 20 && !settled; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await settled
    await run.settle()
    expect(pendingCards(run.journal.snapshot().items)).toEqual([])
    expect(run.publishes.at(-1)?.waiting).toEqual([])
    expect(run.violations()).toEqual([])
  })
})
