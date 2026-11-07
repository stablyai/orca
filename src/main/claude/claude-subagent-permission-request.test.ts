// Real CLI captures verify waiting children have durable cards and child waits do not alter parent status.

import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalResolution
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentChildWorkEvidence } from '../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { AgentStatusStructuredSessionSubject } from '../../shared/agent-status/contracts/agent-status-subject'
import { AgentHookServer } from '../agent-hooks/server'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { StructuredAgentSessionCurrentWork } from '../native-chat/agent-session-wire/observations/structured-agent-session-current-work'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/observations/structured-agent-session-status-feed'
import { indexedStatusFeedSession } from '../native-chat/agent-session-wire/observations/testing/structured-agent-session-status-feed-test-session'
import { invokeCanUseTool } from './claude-can-use-tool-test-support'
import { ClaudeStructuredSessionAdapter } from './structured/claude-structured-session-adapter'
import type { ClaudeStructuredSessionEvent } from './structured/claude-structured-session-state'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './structured/claude-structured-session-test-support'
import { claudeStartupSettled } from './structured/claude-structured-startup-settled-test-support'

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

function askerOf(name: string): string {
  return text(captured(name).find((event) => event.frame.subtype === 'task_started')?.frame.task_id)
}

const ASKER = askerOf('fg-allow')

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
const hooks: { onEvent?: (event: ClaudeStructuredSessionEvent) => void } = {}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-subagent-request-'))
})

afterEach(async () => {
  hooks.onEvent = undefined
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

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
    getConversation: () => null,
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
  // Match host publication on sink publish and deferred journal commits.
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
      cliFlag: async () => 'supported' as const,
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
        {
          fence: FENCE,
          turnScope: new StructuredAgentSessionCurrentWork(journal, FENCE).turnScope()
        }
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
  const ask = async (name: string, options: { withoutAgentId?: boolean } = {}): Promise<void> => {
    const events = captured(name)
    const at = events.findIndex((event) => event.frame.type === 'control_request')
    for (const event of events.slice(0, at + 1)) {
      await step(event, options)
    }
  }
  const violations = () =>
    publishes.filter(
      (entry) =>
        entry.waiting.some((id) => !entry.askers.includes(id)) ||
        !isDeepStrictEqual(entry.row, entry.unwaited)
    )
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

describe("a Claude subagent's permission request", () => {
  it('waits only once its card is written, though the write waits for the journal', async () => {
    const run = await pipeline()
    const events = captured('fg-allow')
    const at = events.findIndex((event) => event.frame.type === 'control_request')
    for (const event of events.slice(0, at)) {
      await run.step(event)
    }
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
})
