// A subagent's work must not re-date the session that spawned it.
//
// The status row takes its completion stamp and acknowledgement clock from the summary's
// `statusStartedAt`. Subagents write into the same journal and keep going after the session's
// own agent has settled, so every hop below is the real one — provider translator, deferred
// sink, durable journal, status feed.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionBackgroundTask,
  AgentSessionStatusEvent
} from '../../../shared/agent-session-wire'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { projectStructuredAgentSessionStatusSummary } from '../../../shared/structured-agent-session-projection'
import { AgentHookServer, _internals } from '../../agent-hooks/server'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'

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

/** A journal, a feed over it, and a sink that publishes into the feed. One clock serves the
 *  journal and every provider event, and it advances on every read: on the wall clock a burst
 *  of appends can share a millisecond, and a `Math.max` over one number moves nothing, so a
 *  contaminated clock would pass. */
async function openSession() {
  let clock = 10_000
  const tick = (): number => (clock += 1_000)
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: { kind: 'codex', threadId: CODEX_THREAD }
    },
    now: tick,
    journalDir: join(root, SESSION)
  })
  // The roster the provider adapter reports, and the host's status row the feed writes into.
  const roster: { tasks: AgentSessionBackgroundTask[] } = { tasks: [] }
  const server = new AgentHookServer()
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([
      [SESSION, indexedStatusFeedSession({ journal, child: { phase: 'ready' } })]
    ]),
    getRecord: () => null,
    now: () => 1,
    readBackgroundTasks: () => ({ state: 'monitoring', tasks: roster.tasks }),
    statusSink: () => ({
      publish: (summary, subject) => server.ingestStructuredStatus(summary, subject),
      forget: (subject) => server.dropStructuredStatus(subject)
    })
  })
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'list-1', emit: (event) => events.push(event) })
  const deferred = createDeferredStructuredAgentSessionEventSink()
  deferred.bind({ journal, fence: 1, publish: () => feed.publish(SESSION, journal) })
  const drain = async (): Promise<void> => {
    expect(await deferred.drained()).toEqual({ ok: true })
  }
  /** The prompt as the host journals it; provider user frames never become user rows. */
  const prompt = (clientMessageId: string, text: string) =>
    journal.appendItem(
      { provider: 'orca', clientMessageId },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
      { fence: 1 }
    )
  const latestStatus = () => {
    const event = events.findLast((candidate) => candidate.type === 'status')
    if (event?.type !== 'status') {
      throw new Error('status publication missing')
    }
    return event.session
  }
  /** The journal's projection now, whether or not the feed republished it. */
  const projected = () => {
    const snapshot = journal.snapshot()
    return projectStructuredAgentSessionStatusSummary(snapshot.items, snapshot.submissions, 1)
  }
  return {
    journal,
    roster,
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

/** The real Codex translator over the session's sink, its clock shared with the journal's. */
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

    // The session's own agent has settled. Its backgrounded child renames itself and then
    // finishes, and each edge revises the session's roster row.
    handle(
      claudeTask('task_updated', { task_id: 'task-1', patch: { description: 'Build watched' } })
    )
    handle(
      claudeTask('task_notification', {
        task_id: 'task-1',
        tool_use_id: 'toolu_1',
        status: 'completed',
        summary: 'green'
      })
    )
    await session.drain()

    // Controls, so the holds below are not vacuous: the child's edges DID reach the journal,
    // and they moved its evidence clock.
    expect(session.journal.cursor().sequence).toBeGreaterThan(sequence)
    expect(session.journal.lastActivityAt()).toBeGreaterThan(evidenceClock)
    expect(session.events).toHaveLength(published)
    expect(session.projected().statusStartedAt).toBe(settled.statusStartedAt)

    // The session's own next turn still moves it.
    await session.prompt('prompt-2', 'thanks')
    handle(claudeUserTurn('user-3', 'thanks'))
    handle(claudeResult('result-2'))
    await session.drain()
    expect(session.latestStatus().statusStartedAt).toBeGreaterThan(settled.statusStartedAt ?? 0)
    translator.dispose()
    session.close()
  })

  // A row live child work holds open is dated by when the host saw it, and mobile decays a working
  // row whose evidence is older than the staleness window. The child's own rows are what keep it.
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
    session.roster.tasks = [{ id: 'task-1', kind: 'agent', state: 'working' }]
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

    // The parent's turn is over; its child runs on, writing prose and spending tokens.
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
    // Whatever else a child row republishes, none of it re-dates the session.
    for (const event of session.events.slice(published)) {
      expect(event).toMatchObject({ session: { statusStartedAt: settled.statusStartedAt } })
    }
    expect(session.projected().statusStartedAt).toBe(settled.statusStartedAt)
    session.close()
  })
})
