import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  producer,
  system,
  toolUse,
  toolResult
} from './claude-child-work-producer-harness.test-fixture'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './structured/journal/claude-structured-journal-translation'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import { claudeProviderHandle } from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  claudeBackgroundTaskBody,
  claudeBackgroundTaskIdentity
} from './claude-background-task-row-journal'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import { ClaudeSubagentIdentities } from './claude-subagent-identities'
import { ClaudeJournaledSubagents } from './claude-subagent-journaled-identities'

const journals = createTrackedJournalOpener()
const cleanup: string[] = []
afterEach(async () => {
  await journals.closeAll()
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
})

it('retains explicit ambient and skip-transcript exclusion when roster omits those optional flags', async () => {
  for (const flag of ['ambient', 'skip_transcript']) {
    const run = await producer()
    run.send(
      system('task_started', {
        task_id: 'excluded',
        task_type: 'local_bash',
        parent_task_id: 'owner',
        is_backgrounded: true,
        tool_use_id: 'tool-old',
        [flag]: true
      })
    )
    run.send(
      system('background_tasks_changed', {
        tasks: [{ task_id: 'excluded', task_type: 'local_bash', parent_task_id: 'owner' }]
      })
    )
    expect
      .soft(
        run.records().filter((row) => row.kind === 'command'),
        flag
      )
      .toEqual([])
    expect
      .soft(
        [...run.journalItems.values()].filter(
          (row) =>
            row.body.kind === 'message' &&
            row.body.blocks.some((block) => block.type === 'background-task')
        ),
        flag
      )
      .toEqual([])
    run.send(
      system('task_notification', {
        task_id: 'excluded',
        tool_use_id: 'tool-old',
        status: 'stopped'
      })
    )
    run.send(toolUse('tool-new', 'Bash', { command: 'sleep 1', run_in_background: true }))
    run.send(
      system('task_started', {
        task_id: 'excluded',
        task_type: 'local_bash',
        tool_use_id: 'tool-new',
        is_backgrounded: true
      })
    )
    expect(run.records().find((row) => row.kind === 'command')).toMatchObject({
      membership: 'live'
    })
  }
})

it('uses the matching durable generation ownership when an earlier run receives a terminal revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-parent-review-codex-'))
  cleanup.push(root)
  const journal = await journals.open({
    identity: {
      sessionId: 'orca-session',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('claude-session', null)
    },
    now: () => 9000,
    stateDirectory: root
  })
  for (const [generation, tool, owner] of [
    [1, 'tool-first', 'owner-first'],
    [2, 'tool-second', 'owner-second'],
    [3, 'tool-root', undefined]
  ] as const) {
    await journal.appendItem(
      claudeBackgroundTaskIdentity('reused', generation),
      claudeBackgroundTaskBody({
        type: 'background-task',
        taskId: 'reused',
        kind: 'command',
        label: 'sleep',
        parentToolUseId: tool,
        state: 'unverifiable',
        startedAt: 1
      }),
      {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE,
        ...(owner
          ? {
              agentId: 'reused',
              parentAgentId: owner,
              producerKind: 'background' as const,
              providerParentRef: tool
            }
          : {})
      }
    )
  }
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: () => {} })
  const translator = createClaudeJournalTranslator({ sink: deferred.sink, coalesceMs: 0 })
  translator.handle({
    type: 'message',
    sessionId: 'orca-session',
    message: {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'reused',
      tool_use_id: 'tool-first',
      status: 'completed'
    }
  })
  expect(await deferred.drained()).toEqual({ ok: true })
  const prior = journal
    .snapshot()
    .items.find(
      (row) =>
        row.body.kind === 'message' &&
        row.body.blocks.some(
          (block) => block.type === 'background-task' && block.parentToolUseId === 'tool-first'
        )
    )
  translator.handle({
    type: 'message',
    sessionId: 'orca-session',
    message: {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'reused',
      status: 'completed'
    }
  })
  expect(await deferred.drained()).toEqual({ ok: true })
  const rootRow = journal
    .snapshot()
    .items.find(
      (row) =>
        row.body.kind === 'message' &&
        row.body.blocks.some(
          (block) => block.type === 'background-task' && block.parentToolUseId === 'tool-root'
        )
    )
  expect(rootRow?.agentId).toBeUndefined()
  expect(rootRow?.body.kind === 'message' ? rootRow.body.blocks : []).toContainEqual(
    expect.objectContaining({ taskId: 'reused', parentToolUseId: 'tool-root', state: 'done' })
  )
  translator.dispose()
  deferred.close()
  expect(prior).toMatchObject({ parentAgentId: 'owner-first', providerParentRef: 'tool-first' })
})

it('advances a journaled nested agent attempt rather than replacing it with the parent placeholder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-nested-parent-recovery-'))
  cleanup.push(root)
  const journal = await journals.open({
    identity: {
      sessionId: 'orca-session',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('claude-session', null)
    },
    now: () => 9000,
    stateDirectory: root
  })
  await journal.appendItem(
    { provider: 'claude', sessionId: 'claude-session', uuid: 'saved-attempt' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'previous attempt' }] },
    {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      agentId: 'nested',
      parentAgentId: 'owner',
      producerKind: 'agent',
      providerParentRef: 'tool-second',
      attempt: 2
    }
  )
  const journaled = new ClaudeJournaledSubagents(() => journal)
  const identities = new ClaudeSubagentIdentities({ journaled })
  identities.observeSystemFrame({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'nested', task_type: 'local_agent', parent_task_id: 'owner' }]
  })
  identities.observeSystemFrame({
    type: 'system',
    subtype: 'task_started',
    task_id: 'nested',
    tool_use_id: 'tool-third',
    task_type: 'local_agent',
    parent_task_id: 'owner'
  })
  expect(identities.linkage.settledLinkageFor('tool-third')).toMatchObject({
    kind: 'linked',
    linkage: { attempt: 3 }
  })
})

it('does not carry an earlier owned shell parent into a distinct lead-owned invocation', async () => {
  const run = await producer()
  run.send(
    system('task_started', {
      task_id: 'owner',
      task_type: 'local_agent',
      tool_use_id: 'spawn-owner',
      is_backgrounded: true
    })
  )
  run.send(
    system('task_started', {
      task_id: 'reused',
      task_type: 'local_bash',
      tool_use_id: 'tool-first',
      parent_task_id: 'owner',
      is_backgrounded: true
    })
  )
  run.send(
    system('task_notification', { task_id: 'reused', tool_use_id: 'tool-first', status: 'stopped' })
  )
  run.send(toolUse('tool-root', 'Bash', { command: 'sleep 1', run_in_background: true }))
  run.send(
    system('task_started', {
      task_id: 'reused',
      task_type: 'local_bash',
      tool_use_id: 'tool-root',
      is_backgrounded: true
    })
  )
  const newer = [...run.journalItems.values()].find(
    (row) =>
      row.body.kind === 'message' &&
      row.body.blocks.some(
        (block) => block.type === 'background-task' && block.parentToolUseId === 'tool-root'
      )
  )
  expect.soft(newer).toBeDefined()
  expect.soft(newer?.agentId).toBeUndefined()
  const owner = run.records().find((row) => row.kind === 'agent')
  const child = run.records().find((row) => row.kind === 'command')
  expect(child?.parentChildWorkId).not.toBe(owner?.childWorkId)
})

it('keeps a monitor tool result out of the transcript when a later parent roster omits its classification', async () => {
  const run = await producer()
  run.send(toolUse('tool-monitor', 'Monitor', { command: 'watch' }))
  run.send({
    ...toolResult('tool-monitor', 'Started'),
    tool_use_result: { taskId: 'monitor-task' }
  })
  run.send(
    system('background_tasks_changed', {
      tasks: [{ task_id: 'monitor-task', task_type: 'local_bash', parent_task_id: 'owner' }]
    })
  )
  expect(
    [...run.journalItems.values()].filter(
      (row) =>
        row.body.kind === 'message' &&
        row.body.blocks.some((block) => block.type === 'background-task')
    )
  ).toEqual([])
})
