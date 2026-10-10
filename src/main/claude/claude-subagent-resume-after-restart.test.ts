import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatSubagentEntry
} from '../../shared/native-chat-types'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { claudeSubagentGroupBody, claudeSubagentGroupIdentity } from './claude-subagent-group-row'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

// Frame orders are real sessions', scrubbed. A resumed agent's frames still name its ORIGINAL
// spawn call while the announcement names the message call that resumed it, and a new provider
// run knows neither unless it reads what the earlier run journaled.

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-subagent-restart-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function frame(message: Record<string, unknown>, startsTurn = false) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    ...(startsTurn ? { startsTurn: true as const } : {}),
    message: { session_id: 'claude-session', parent_tool_use_id: null, ...message }
  }
}

const userTurn = (uuid: string) =>
  frame(
    { type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
    true
  )

const toolCall = (uuid: string, id: string, name: string, input: Record<string, unknown>) =>
  frame({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
  })

const toolResult = (uuid: string, toolUseId: string, content: string) =>
  frame({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] }
  })

const taskStarted = (taskId: string, toolUseId: string, description: string) =>
  frame({
    type: 'system',
    subtype: 'task_started',
    uuid: `started-${toolUseId}`,
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    subagent_type: 'general-purpose',
    is_backgrounded: true,
    task_type: 'local_agent'
  })

const taskFailed = (taskId: string, toolUseId: string) =>
  frame({
    type: 'system',
    subtype: 'task_notification',
    uuid: `failed-${taskId}`,
    task_id: taskId,
    tool_use_id: toolUseId,
    status: 'failed'
  })

const taskCompleted = (taskId: string, toolUseId: string) =>
  frame({
    type: 'system',
    subtype: 'task_notification',
    uuid: `completed-${taskId}`,
    task_id: taskId,
    tool_use_id: toolUseId,
    status: 'completed'
  })

/** A call a CHILD makes: its frame names the child's own spawn call as parent. */
const childToolCall = (
  uuid: string,
  parentToolUseId: string,
  id: string,
  input: Record<string, unknown>
) =>
  frame({
    type: 'assistant',
    uuid,
    parent_tool_use_id: parentToolUseId,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input }] }
  })

const childSays = (uuid: string, parentToolUseId: string, text: string) =>
  frame({
    type: 'assistant',
    uuid,
    parent_tool_use_id: parentToolUseId,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })

const result = (uuid: string) =>
  frame({ type: 'result', subtype: 'success', is_error: false, result: 'done', uuid })

async function openJournal(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: {
      sessionId: 'orca-session',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('claude-session', null)
    },
    now: () => 9_000,
    stateDirectory: root
  })
}

/** One provider process: a fresh sink and translator over the session's journal. */
function acquire(journal: AgentSessionJournal) {
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  const translator = createClaudeJournalTranslator({ sink: deferred.sink, coalesceMs: 0 })
  deferred.bind({ journal, fence: 1, publish: () => {} })
  const settle = async (): Promise<void> => {
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
  }
  const exit = async (): Promise<void> => {
    translator.handle({ type: 'ended', sessionId: 'orca-session', reason: 'closed' })
    await settle()
    translator.dispose()
    deferred.close()
  }
  return { translator, settle, exit }
}

const proseRow = (journal: AgentSessionJournal, text: string): AgentJournalRenderItem | undefined =>
  journal
    .snapshot()
    .items.find(
      (item) =>
        item.body.kind === 'message' &&
        item.body.blocks.some((block) => block.type === 'text' && block.text === text)
    )

type GroupRow = { groupId: string; revision: number; agents: NativeChatSubagentEntry[] }

/** Every spawn-group row, as a reader sees it now. */
const groupRows = (journal: AgentSessionJournal): GroupRow[] =>
  journal.snapshot().items.flatMap((item) => {
    const block = item.body.kind === 'message' ? item.body.blocks.find(isSubagentGroupBlock) : null
    return block ? [{ groupId: block.groupId, revision: item.revision, agents: block.agents }] : []
  })

const rowsListing = (journal: AgentSessionJournal, agentId: string): GroupRow[] =>
  groupRows(journal).filter((row) => row.agents.some((agent) => agent.id === agentId))

/** Every task a background-task row names. */
const backgroundTaskIds = (journal: AgentSessionJournal): string[] =>
  journal
    .snapshot()
    .items.flatMap((item) =>
      item.body.kind === 'message'
        ? item.body.blocks.flatMap((block) => (isBackgroundTaskBlock(block) ? [block.taskId] : []))
        : []
    )

/** Every id any spawn-group row names: what a transcript can put a name on. */
const rosterIds = (journal: AgentSessionJournal): Set<string> =>
  new Set(groupRows(journal).flatMap((row) => row.agents.map((agent) => agent.id)))

/** An older build re-rostered a resumed child in the later turn's row, so two rows list it. */
async function journalAnOlderBuildListedTwice(): Promise<AgentSessionJournal> {
  const journal = await openJournal()
  const older = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  older.bind({ journal, fence: 1, publish: () => {} })
  const listed = (id: string, state: NativeChatSubagentEntry['state']) => ({
    id,
    label: `Child ${id}`,
    state,
    startedAt: 1,
    settledAt: 2
  })
  for (const [groupId, agents] of [
    [
      'claude-session:turn-a',
      [listed('agent-a', 'unverifiable'), listed('agent-b', 'unverifiable')]
    ],
    ['claude-session:turn-b', [listed('agent-a', 'completed')]]
  ] as const) {
    older.sink.appendItem(
      claudeSubagentGroupIdentity(groupId),
      claudeSubagentGroupBody(groupId, agents),
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await expect(older.drained()).resolves.toEqual({ ok: true })
  older.close()
  return journal
}

const agentAStateByRow = (journal: AgentSessionJournal): Record<string, string | undefined> =>
  Object.fromEntries(
    rowsListing(journal, 'agent-a').map((row) => [
      row.groupId,
      row.agents.find((agent) => agent.id === 'agent-a')?.state
    ])
  )

describe('a Claude subagent resumed after its provider restarted', () => {
  it('keeps the canonical id its first run was given, so one child stays one child', async () => {
    const journal = await openJournal()

    const first = acquire(journal)
    first.translator.handle(userTurn('turn-a'))
    first.translator.handle(
      toolCall('spawn-a', 'toolu_spawn_a', 'Agent', {
        description: 'Follow-up A',
        run_in_background: true
      })
    )
    first.translator.handle(taskStarted('agent-a', 'toolu_spawn_a', 'Follow-up A'))
    first.translator.handle(toolResult('spawned-a', 'toolu_spawn_a', 'Async agent launched.'))
    first.translator.handle(childSays('a-1', 'toolu_spawn_a', 'A reads the rig recipes'))
    first.translator.handle(
      toolCall('spawn-b', 'toolu_spawn_b', 'Agent', {
        description: 'Follow-up B',
        run_in_background: true
      })
    )
    first.translator.handle(taskStarted('agent-b', 'toolu_spawn_b', 'Follow-up B'))
    first.translator.handle(toolResult('spawned-b', 'toolu_spawn_b', 'Async agent launched.'))
    first.translator.handle(childSays('b-1', 'toolu_spawn_b', 'B inspects the worktree'))
    first.translator.handle(taskFailed('agent-b', 'toolu_spawn_b'))
    first.translator.handle(taskFailed('agent-a', 'toolu_spawn_a'))
    first.translator.handle(result('result-a'))
    await first.exit()
    expect(proseRow(journal, 'A reads the rig recipes')).toMatchObject({ agentId: 'agent-a' })

    const second = acquire(journal)
    second.translator.handle(userTurn('turn-b'))
    second.translator.handle(
      toolCall('resume-a', 'toolu_message_a', 'SendMessage', { to: 'agent-a', message: 'go on' })
    )
    second.translator.handle(taskStarted('agent-a', 'toolu_message_a', 'Follow-up A'))
    second.translator.handle(toolResult('resumed-a', 'toolu_message_a', '{"success":true}'))
    second.translator.handle(
      toolCall('resume-b', 'toolu_message_b', 'SendMessage', { to: 'agent-b', message: 'go on' })
    )
    second.translator.handle(taskStarted('agent-b', 'toolu_message_b', 'Follow-up B'))
    second.translator.handle(toolResult('resumed-b', 'toolu_message_b', '{"success":true}'))
    // Interleaved, as the two resumed agents were: neither may take the other's id.
    second.translator.handle(childSays('a-2', 'toolu_spawn_a', 'A restarts the receiver'))
    second.translator.handle(childSays('b-2', 'toolu_spawn_b', 'B checks the rig'))
    await second.settle()

    expect(proseRow(journal, 'A restarts the receiver')).toMatchObject({
      agentId: 'agent-a',
      providerParentRef: 'toolu_spawn_a',
      producerKind: 'agent'
    })
    expect(proseRow(journal, 'B checks the rig')).toMatchObject({
      agentId: 'agent-b',
      providerParentRef: 'toolu_spawn_b'
    })
    // The resume revised the child's own entry, as it would have without a restart: one row names
    // it, and its rows say which run of it they are.
    expect(rowsListing(journal, 'agent-a')).toEqual([
      expect.objectContaining({
        groupId: 'claude-session:turn-a',
        agents: [
          expect.objectContaining({ id: 'agent-a', state: 'working' }),
          expect.objectContaining({ id: 'agent-b', state: 'working' })
        ]
      })
    ])
    expect(proseRow(journal, 'A reads the rig recipes')?.attempt).toBeUndefined()
    expect(proseRow(journal, 'A restarts the receiver')?.attempt).toBe(2)
    expect(proseRow(journal, 'B checks the rig')?.attempt).toBe(2)
    // What a reader sees: every child row names an agent a roster can name.
    const named = rosterIds(journal)
    const childRows = journal.snapshot().items.filter((item) => item.agentId !== undefined)
    expect(childRows.length).toBeGreaterThan(0)
    expect(childRows.filter((item) => !named.has(item.agentId ?? ''))).toEqual([])
    await second.exit()
  })

  it('keeps the earlier run’s children in the roster row no turn owns', async () => {
    // A backgrounded child spawns its own child after the parent's turn has ended, so the
    // grandchild is rostered outside any turn; the next provider run does the same again.
    const journal = await openJournal()
    const first = acquire(journal)
    first.translator.handle(userTurn('turn-a'))
    first.translator.handle(
      toolCall('spawn-c', 'toolu_spawn_c', 'Agent', {
        description: 'Readiness',
        run_in_background: true
      })
    )
    first.translator.handle(taskStarted('agent-c', 'toolu_spawn_c', 'Readiness'))
    first.translator.handle(toolResult('spawned-c', 'toolu_spawn_c', 'Async agent launched.'))
    first.translator.handle(result('result-a'))
    first.translator.handle(
      childToolCall('c-spawn', 'toolu_spawn_c', 'toolu_spawn_x', { description: 'Sweep leases' })
    )
    first.translator.handle(taskStarted('agent-x', 'toolu_spawn_x', 'Sweep leases'))
    first.translator.handle(childSays('x-1', 'toolu_spawn_x', 'X reads the hydration'))
    first.translator.handle(taskCompleted('agent-x', 'toolu_spawn_x'))
    first.translator.handle(taskCompleted('agent-c', 'toolu_spawn_c'))
    await first.exit()
    expect(rowsListing(journal, 'agent-x')).toEqual([
      expect.objectContaining({ groupId: 'outside-turn' })
    ])

    const second = acquire(journal)
    second.translator.handle(userTurn('turn-b'))
    second.translator.handle(
      toolCall('spawn-d', 'toolu_spawn_d', 'Agent', {
        description: 'Checklist',
        run_in_background: true
      })
    )
    second.translator.handle(taskStarted('agent-d', 'toolu_spawn_d', 'Checklist'))
    second.translator.handle(toolResult('spawned-d', 'toolu_spawn_d', 'Async agent launched.'))
    second.translator.handle(result('result-b'))
    second.translator.handle(
      childToolCall('d-spawn', 'toolu_spawn_d', 'toolu_spawn_y', { description: 'Run checklist' })
    )
    second.translator.handle(taskStarted('agent-y', 'toolu_spawn_y', 'Run checklist'))
    await second.settle()

    const outside = groupRows(journal).filter((row) => row.groupId === 'outside-turn')
    expect(outside).toEqual([
      expect.objectContaining({
        agents: [
          expect.objectContaining({ id: 'agent-x', label: 'Sweep leases', state: 'completed' }),
          expect.objectContaining({ id: 'agent-y', label: 'Run checklist', state: 'working' })
        ]
      })
    ])
    expect(proseRow(journal, 'X reads the hydration')?.agentId).toBe('agent-x')
    expect(rosterIds(journal).has('agent-x')).toBe(true)
    await second.exit()
  })

  it('takes Claude’s verdict on a child the earlier run lost contact with, and reopens it on an announcement', async () => {
    // The provider exited while its backgrounded child still ran, so the roster said contact was
    // lost. The next run is told the child did not finish, works on its own, then messages it.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const journal = await openJournal()
    const first = acquire(journal)
    first.translator.handle(userTurn('turn-a'))
    first.translator.handle(
      toolCall('spawn-a', 'toolu_spawn_a', 'Agent', {
        description: 'Grok PR',
        run_in_background: true
      })
    )
    first.translator.handle(taskStarted('agent-a', 'toolu_spawn_a', 'Grok PR'))
    first.translator.handle(toolResult('spawned-a', 'toolu_spawn_a', 'Async agent launched.'))
    first.translator.handle(childSays('a-1', 'toolu_spawn_a', 'A reads the docs'))
    first.translator.handle(result('result-a'))
    await first.exit()
    const [lost] = rowsListing(journal, 'agent-a')
    expect(lost?.agents).toEqual([
      expect.objectContaining({ id: 'agent-a', state: 'unverifiable' })
    ])
    const lostAt = lost?.agents[0]?.settledAt
    expect(lostAt).toBe(1_000_000)

    // The restart comes much later: that is not when the child stopped.
    vi.setSystemTime(5_000_000)
    const second = acquire(journal)
    second.translator.handle(userTurn('turn-b'))
    second.translator.handle(
      frame({
        type: 'system',
        subtype: 'task_notification',
        uuid: 'unfinished-a',
        task_id: 'agent-a',
        status: 'stopped',
        summary: 'Background agent "Grok PR" didn\'t finish before the previous session ended'
      })
    )
    second.translator.handle(toolCall('bash-1', 'toolu_bash_1', 'Bash', { command: 'git status' }))
    second.translator.handle(toolResult('bashed-1', 'toolu_bash_1', 'clean'))
    await second.settle()
    // The child's own row takes the verdict, keeping when that run lost it; no second row names it.
    expect(rowsListing(journal, 'agent-a')).toEqual([
      expect.objectContaining({
        groupId: 'claude-session:turn-a',
        agents: [expect.objectContaining({ id: 'agent-a', state: 'stopped', settledAt: lostAt })]
      })
    ])
    expect(backgroundTaskIds(journal)).toEqual([])

    // The resume is a new run: its clock starts now, not at the first run's start.
    vi.setSystemTime(5_100_000)
    second.translator.handle(
      toolCall('resume-a', 'toolu_message_a', 'SendMessage', { to: 'agent-a', message: 'resume' })
    )
    second.translator.handle(taskStarted('agent-a', 'toolu_message_a', 'Grok PR'))
    second.translator.handle(childSays('a-2', 'toolu_spawn_a', 'A resumes the capture'))
    await second.settle()
    expect(rowsListing(journal, 'agent-a')).toEqual([
      expect.objectContaining({
        groupId: 'claude-session:turn-a',
        agents: [expect.objectContaining({ id: 'agent-a', state: 'working', startedAt: 5_100_000 })]
      })
    ])
    expect(rowsListing(journal, 'agent-a')[0]?.agents[0]?.settledAt).toBeUndefined()
    expect(proseRow(journal, 'A resumes the capture')).toMatchObject({
      agentId: 'agent-a',
      attempt: 2
    })
    await second.exit()
  })

  it('invents no stop time for a child whose host died without sweeping it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const crashed = await openJournal()
    const first = acquire(crashed)
    first.translator.handle(userTurn('turn-a'))
    first.translator.handle(
      toolCall('spawn-a', 'toolu_spawn_a', 'Agent', {
        description: 'Grok PR',
        run_in_background: true
      })
    )
    first.translator.handle(taskStarted('agent-a', 'toolu_spawn_a', 'Grok PR'))
    await first.settle()
    // The host dies: nothing sweeps the child, and reopening the journal can say only that
    // contact was lost, not when.
    await crashed.close()
    const journal = await openJournal()
    const [lost] = rowsListing(journal, 'agent-a')[0]?.agents ?? []
    expect(lost).toMatchObject({ id: 'agent-a', state: 'unverifiable' })
    expect(lost?.settledAt).toBeUndefined()

    vi.setSystemTime(5_000_000)
    const second = acquire(journal)
    second.translator.handle(userTurn('turn-b'))
    second.translator.handle(
      frame({
        type: 'system',
        subtype: 'task_notification',
        uuid: 'unfinished-a',
        task_id: 'agent-a',
        status: 'stopped'
      })
    )
    await second.settle()
    const [stopped] = rowsListing(journal, 'agent-a')[0]?.agents ?? []
    expect(stopped).toMatchObject({ id: 'agent-a', state: 'stopped' })
    expect(stopped?.settledAt).toBeUndefined()
    await second.exit()
  })

  it('keeps one live entry for a child an older build listed in two rows', async () => {
    const journal = await journalAnOlderBuildListedTwice()
    const run = acquire(journal)
    run.translator.handle(userTurn('turn-c'))
    run.translator.handle(taskStarted('agent-a', 'toolu_message_a', 'Child agent-a'))
    // A frame for a sibling only the other row lists brings that row in too.
    run.translator.handle(taskCompleted('agent-b', 'toolu_spawn_b'))
    run.translator.handle(taskCompleted('agent-a', 'toolu_message_a'))
    await run.settle()

    // The copy the resume reopened is the one its outcome lands on; nothing is left running.
    expect(agentAStateByRow(journal)).toEqual({
      'claude-session:turn-a': 'unverifiable',
      'claude-session:turn-b': 'completed'
    })
    await run.exit()
  })

  it('resumes a twice-listed child in its later row even when a sibling reaches the older row first', async () => {
    const journal = await journalAnOlderBuildListedTwice()
    const run = acquire(journal)
    run.translator.handle(userTurn('turn-c'))
    run.translator.handle(taskCompleted('agent-b', 'toolu_spawn_b'))
    run.translator.handle(taskStarted('agent-a', 'toolu_message_a', 'Child agent-a'))
    await run.settle()

    expect(agentAStateByRow(journal)).toEqual({
      'claude-session:turn-a': 'unverifiable',
      'claude-session:turn-b': 'working'
    })
    await run.exit()
  })

  it('still files a child no journaled row resolved under its own reference, never the parent', async () => {
    const journal = await openJournal()
    const first = acquire(journal)
    first.translator.handle(userTurn('turn-a'))
    first.translator.handle(result('result-a'))
    await first.exit()

    const second = acquire(journal)
    second.translator.handle(userTurn('turn-b'))
    second.translator.handle(taskStarted('agent-other', 'toolu_other', 'Other'))
    second.translator.handle(childSays('c-1', 'toolu_unknown', 'nobody named me'))
    await second.settle()

    // A control: nothing recalled for an id the journal never resolved, so no id is invented.
    expect(proseRow(journal, 'nobody named me')).toMatchObject({
      agentId: 'toolu_unknown',
      providerParentRef: 'toolu_unknown'
    })
    await second.exit()
  })
})
