import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/structured-agent-session-projection'
import { AgentHookServer, _internals } from '../../agent-hooks/server'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import {
  subagentJournalBody,
  subagentJournalItemIdentity
} from '../agent-session-journal/journal-subagent-item'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const SESSION = 'recency-session'
const CODEX_THREAD = 'thread-parent'
const CODEX_CHILD = 'thread-child'

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  _internals.resetCachesForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-subagent-recency-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** Advance on every read: a same-millisecond burst could hide contamination of the session clock. */
async function openSession() {
  let clock = 10_000
  const tick = (): number => (clock += 1_000)
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: codexProviderHandle(CODEX_THREAD)
    },
    now: tick,
    stateDirectory: join(root, SESSION)
  })
  const server = new AgentHookServer()
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([
      [
        SESSION,
        indexedStatusFeedSession({
          journal,
          child: { phase: 'ready', generation: 'child-1', fence: 1 }
        })
      ]
    ]),
    getRecord: () => null,
    now: () => 1,
    statusSink: () => ({
      publish: (summary, subject) => server.ingestStructuredStatus(summary, subject),
      forget: (subject) => server.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        server.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
    })
  })
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'list-1', emit: (event) => events.push(event) })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: () => feed.publish(SESSION, journal) })
  const drain = async (): Promise<void> => {
    expect(await deferred.drained()).toEqual({ ok: true })
  }
  // Provider user frames never become personal rows.
  const prompt = (clientMessageId: string, text: string) =>
    journal.appendItem(
      { provider: 'orca', clientMessageId },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  const latestStatus = () => {
    const event = events.findLast((candidate) => candidate.type === 'status')
    if (event?.type !== 'status') {
      throw new Error('status publication missing')
    }
    return event.session
  }
  const projected = () => {
    const snapshot = journal.snapshot()
    return projectStructuredAgentSessionStatusSummary(snapshot.items, snapshot.submissions, 1)
  }
  return {
    journal,
    feed,
    server,
    projected,
    tick,
    sink: deferred.sink,
    events,
    prompt,
    drain,
    latestStatus,
    close: deferred.close
  }
}

function claudeFrame(message: Record<string, unknown>, startsTurn = false) {
  return {
    type: 'message' as const,
    sessionId: SESSION,
    ...(startsTurn ? { startsTurn: true as const } : {}),
    message: { session_id: 'claude-session', ...message }
  }
}

function claudeUserTurn(uuid: string, text: string) {
  return claudeFrame(
    {
      type: 'user',
      uuid,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] }
    },
    true
  )
}

function claudeResult(uuid: string) {
  return claudeFrame({ type: 'result', subtype: 'success', uuid, result: 'ok' })
}

function claudeTask(subtype: string, fields: Record<string, unknown>) {
  return claudeFrame({ type: 'system', subtype, ...fields })
}

function codexTranslator(session: Awaited<ReturnType<typeof openSession>>) {
  const translator = createCodexJournalTranslator({
    sink: session.sink,
    sessionId: SESSION,
    primaryThreadId: () => CODEX_THREAD,
    now: session.tick,
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  const on = (threadId: string, method: string, params: Record<string, unknown> = {}) =>
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId,
      method,
      params: { threadId, ...params },
      observedAt: session.tick()
    })
  const item = (threadId: string, method: string, turnId: string, body: Record<string, unknown>) =>
    on(threadId, method, { turnId, item: body })
  return { translator, on, item }
}

describe("a subagent's work and the recency of the session that spawned it", () => {
  it("holds an idle Claude session's clock while its backgrounded subagent reports and finishes", async () => {
    const session = await openSession()
    const translator = createClaudeJournalTranslator({ sink: session.sink })
    const handle = (event: ReturnType<typeof claudeFrame>): void =>
      translator.handle({ ...event, observedAt: session.tick() })
    const hostRow = (label: string, state: 'working' | 'completed') =>
      session.journal.appendItem(
        subagentJournalItemIdentity('task-1'),
        subagentJournalBody({
          type: 'subagent',
          id: 'task-1',
          label,
          state,
          groupId: 'thread',
          run: 'toolu_1'
        }),
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    await session.prompt('prompt-1', 'fan out')
    handle(claudeUserTurn('user-1', 'fan out'))
    handle(
      claudeFrame({
        type: 'assistant',
        uuid: 'assistant-1',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'delegating' },
            { type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'x' } }
          ]
        }
      })
    )
    handle(
      claudeTask('task_started', {
        task_id: 'task-1',
        tool_use_id: 'toolu_1',
        task_type: 'local_agent',
        description: 'Watch the build',
        is_backgrounded: true
      })
    )
    handle(
      claudeFrame({
        type: 'user',
        uuid: 'user-2',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'launched' }]
        }
      })
    )
    handle(claudeResult('result-1'))
    await session.drain()
    const settled = session.latestStatus()
    expect(settled).toMatchObject({ status: 'idle', statusStartedAt: expect.any(Number) })
    const evidenceClock = session.journal.lastActivityAt()
    const published = session.events.length
    const sequence = session.journal.cursor().sequence

    handle(
      claudeTask('task_updated', { task_id: 'task-1', patch: { description: 'Build watched' } })
    )
    await hostRow('Build watched', 'working')
    handle(
      claudeTask('task_notification', {
        task_id: 'task-1',
        tool_use_id: 'toolu_1',
        status: 'completed',
        summary: 'green'
      })
    )
    await hostRow('Build watched', 'completed')
    await session.drain()

    // Confirm child events landed and advanced journal evidence before checking the session clock.
    expect(session.journal.cursor().sequence).toBeGreaterThan(sequence)
    expect(session.journal.lastActivityAt()).toBeGreaterThan(evidenceClock)
    expect(session.events).toHaveLength(published)
    expect(session.projected().statusStartedAt).toBe(settled.statusStartedAt)

    await session.prompt('prompt-2', 'thanks')
    handle(claudeUserTurn('user-3', 'thanks'))
    handle(claudeResult('result-2'))
    await session.drain()
    expect(session.latestStatus().statusStartedAt).toBeGreaterThan(settled.statusStartedAt ?? 0)
    translator.dispose()
    session.close()
  })

  // Mobile decays stale working rows; live child evidence must keep their host row fresh.
  it("keeps the host's evidence fresh while a live subagent holds an idle Claude session open", async () => {
    const session = await openSession()
    const translator = createClaudeJournalTranslator({ sink: session.sink })
    const handle = (event: ReturnType<typeof claudeFrame>): void =>
      translator.handle({ ...event, observedAt: session.tick() })
    await session.prompt('prompt-1', 'fan out')
    handle(claudeUserTurn('user-1', 'fan out'))
    handle(
      claudeFrame({
        type: 'assistant',
        uuid: 'assistant-1',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'x' } }]
        }
      })
    )
    // Host ordering lands the spawn frame before its child record.
    await session.drain()
    session.feed.publishChildWork(SESSION, [
      {
        type: 'live',
        observedAt: session.tick(),
        child: {
          handle: { idKind: 'task_id', id: 'task-1', runId: 'toolu_1' },
          kind: 'agent',
          residency: 'background',
          state: 'working',
          stoppable: true
        }
      }
    ])
    handle(claudeResult('result-1'))
    await session.drain()
    const settled = session.latestStatus()
    expect(settled).toMatchObject({ status: 'idle', statusStartedAt: expect.any(Number) })
    const [heldOpen] = session.server.getStatusSnapshot()
    expect(heldOpen).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })

    const later = (heldOpen?.evidenceObservedAt ?? 0) + AGENT_STATUS_STALE_AFTER_MS + 1
    vi.spyOn(Date, 'now').mockReturnValue(later)
    handle(
      claudeFrame({
        type: 'assistant',
        uuid: 'child-assistant-1',
        parent_tool_use_id: 'toolu_1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'still reviewing' }] }
      })
    )
    await session.drain()

    expect(session.server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      evidenceObservedAt: later,
      stateStartedAt: heldOpen?.stateStartedAt,
      mainAgent: { state: 'done', stateStartedAt: settled.statusStartedAt }
    })
    translator.dispose()
    session.close()
  })

  it("holds an idle Codex session's clock while its subagent streams rows and spends tokens", async () => {
    const session = await openSession()
    const { on, item } = codexTranslator(session)
    await session.prompt('prompt-1', 'fan out')
    on(CODEX_THREAD, 'turn/started', { turn: { id: 'parent-turn' } })
    const spawn = {
      type: 'subAgentActivity',
      id: 'spawn-child',
      kind: 'started',
      agentThreadId: CODEX_CHILD,
      agentPath: '/root/review'
    }
    item(CODEX_THREAD, 'item/started', 'parent-turn', spawn)
    item(CODEX_THREAD, 'item/completed', 'parent-turn', spawn)
    on(CODEX_CHILD, 'turn/started', { turn: { id: 'child-turn' } })
    on(CODEX_THREAD, 'turn/completed', { turn: { id: 'parent-turn', status: 'completed' } })
    await session.drain()
    const settled = session.latestStatus()
    expect(settled).toMatchObject({ status: 'idle', statusStartedAt: expect.any(Number) })
    const evidenceClock = session.journal.lastActivityAt()
    const published = session.events.length
    const sequence = session.journal.cursor().sequence

    item(CODEX_CHILD, 'item/completed', 'child-turn', {
      type: 'agentMessage',
      id: 'child-message',
      text: 'reviewing'
    })
    on(CODEX_CHILD, 'thread/tokenUsage/updated', {
      turnId: 'child-turn',
      tokenUsage: { total: { totalTokens: 900 } }
    })
    on(CODEX_CHILD, 'turn/completed', { turn: { id: 'child-turn', status: 'completed' } })
    await session.drain()

    expect(session.journal.cursor().sequence).toBeGreaterThan(sequence)
    expect(session.journal.lastActivityAt()).toBeGreaterThan(evidenceClock)
    for (const event of session.events.slice(published)) {
      expect(event).toMatchObject({ session: { statusStartedAt: settled.statusStartedAt } })
    }
    expect(session.projected().statusStartedAt).toBe(settled.statusStartedAt)
    session.close()
  })
})
