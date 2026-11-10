import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  producer,
  frame,
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
import {
  adapterAtPublishFor,
  fakeClaude,
  identityFor
} from './structured/claude-structured-session-test-support'
import type { AgentChildWorkEvidence } from '../../shared/agent-status/child-work/agent-status-child-work-evidence'
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
    run.send(
      system('task_updated', {
        task_id: 'excluded',
        patch: { status: 'running', is_backgrounded: true, description: 'Excluded shell' }
      })
    )
    expect.soft(run.records(), flag).toEqual([])
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
    run.send(
      system('task_progress', {
        task_id: 'excluded',
        tool_use_id: 'tool-pending',
        parent_task_id: 'pending-owner',
        [flag]: true
      })
    )
    run.send(
      system('task_notification', {
        task_id: 'excluded',
        tool_use_id: 'tool-new',
        status: 'stopped'
      })
    )
    run.send(
      system('task_started', {
        task_id: 'excluded',
        task_type: 'local_bash',
        tool_use_id: 'tool-pending',
        is_backgrounded: true
      })
    )
    expect(run.records().filter((row) => row.membership === 'live')).toEqual([])
    expect(
      [...run.journalItems.values()].some(
        (row) =>
          row.body.kind === 'message' &&
          row.body.blocks.some(
            (block) => block.type === 'background-task' && block.parentToolUseId === 'tool-pending'
          )
      )
    ).toBe(false)
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
      session_id: 'claude-session',
      uuid: 'historical-owned-completion',
      status: 'completed'
    }
  })
  expect(await deferred.drained()).toEqual({ ok: true })
  expect(journal.runningTurn()).toBeNull()
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
  translator.handle({
    type: 'message',
    sessionId: 'orca-session',
    message: system('task_started', {
      task_id: 'reused',
      task_type: 'local_bash',
      tool_use_id: 'tool-first',
      parent_task_id: 'owner-first',
      is_backgrounded: true
    })
  })
  expect(await deferred.drained()).toEqual({ ok: true })
  const oldBody = journal
    .snapshot()
    .items.find((row) => row.providerParentRef === 'tool-first')?.body
  expect(oldBody?.kind === 'message' ? oldBody.blocks : []).toContainEqual(
    expect.objectContaining({ parentToolUseId: 'tool-first', state: 'done' })
  )
  translator.dispose()
  deferred.close()
  const queued = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  const pending = createClaudeJournalTranslator({ sink: queued.sink, coalesceMs: 0 })
  const feed = (subtype: string, fields: Record<string, unknown>) =>
    pending.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: system(subtype, fields)
    })
  feed('task_started', {
    task_id: 'queued',
    task_type: 'local_bash',
    tool_use_id: 'queued-old',
    parent_task_id: 'owner-first',
    is_backgrounded: true
  })
  feed('task_notification', { task_id: 'queued', tool_use_id: 'queued-old', status: 'stopped' })
  feed('task_progress', {
    task_id: 'queued',
    tool_use_id: 'queued-new',
    description: 'New operation before announcement'
  })
  feed('task_started', {
    task_id: 'queued',
    task_type: 'local_bash',
    tool_use_id: 'queued-new',
    parent_task_id: 'owner-second',
    is_backgrounded: true
  })
  feed('task_updated', {
    task_id: 'queued',
    tool_use_id: 'queued-old',
    patch: { status: 'completed' }
  })
  feed('task_progress', {
    task_id: 'queued',
    tool_use_id: 'queued-old',
    description: 'Old operation'
  })
  queued.bind({ journal, fence: 1, publish: () => {} })
  expect(await queued.drained()).toEqual({ ok: true })
  const queuedRows = journal
    .snapshot()
    .items.filter(
      (row) =>
        row.body.kind === 'message' &&
        row.body.blocks.some(
          (block) => block.type === 'background-task' && block.taskId === 'queued'
        )
    )
  expect(queuedRows).toHaveLength(2)
  const current = queuedRows.find((row) => row.providerParentRef === 'queued-new')
  expect(current).toMatchObject({ parentAgentId: 'owner-second' })
  expect(current?.body.kind === 'message' ? current.body.blocks : []).toContainEqual(
    expect.objectContaining({ parentToolUseId: 'queued-new', state: 'working' })
  )
  pending.dispose()
  queued.close()
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

it.each(['notification', 'killed', 'failed'])(
  'keeps distinct shell invocations isolated after %s',
  async (ending) => {
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
      ending === 'notification'
        ? system('task_notification', {
            task_id: 'reused',
            tool_use_id: 'tool-first',
            status: 'stopped'
          })
        : system('task_updated', { task_id: 'reused', patch: { status: ending } })
    )
    run.send(
      system('task_progress', {
        task_id: 'reused',
        tool_use_id: 'tool-root',
        description: 'New operation before announcement'
      })
    )
    expect(run.records().find((row) => row.kind === 'command')).toMatchObject({
      membership: 'settled',
      stoppable: false
    })
    expect(
      [...run.journalItems.values()].filter(
        (row) =>
          row.body.kind === 'message' &&
          row.body.blocks.some((block) => block.type === 'background-task')
      )
    ).toHaveLength(1)
    run.send(toolUse('tool-root', 'Bash', { command: 'sleep 1', run_in_background: true }))
    run.send(
      system('task_started', {
        task_id: 'reused',
        task_type: 'local_bash',
        tool_use_id: 'tool-root',
        is_backgrounded: true
      })
    )
    run.send(
      system('task_updated', {
        task_id: 'reused',
        tool_use_id: 'tool-first',
        patch: { status: 'completed' }
      })
    )
    run.send(
      system('task_progress', {
        task_id: 'reused',
        tool_use_id: 'tool-first',
        description: 'Old operation'
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
    expect(child).toMatchObject({ membership: 'live', stoppable: true })
    expect(JSON.stringify(child)).not.toContain('Old operation')
    expect(newer?.body.kind === 'message' ? newer.body.blocks : []).toContainEqual(
      expect.objectContaining({ parentToolUseId: 'tool-root', state: 'working' })
    )
  }
)

it.each([false, true])(
  'keeps Monitor invocation reports out of the transcript, reused ID: %s',
  async (reused) => {
    const run = await producer()
    if (reused) {
      run.send(toolUse('tool-old', 'Bash', { command: 'sleep 1', run_in_background: true }))
      run.send(
        system('task_started', {
          task_id: 'monitor-task',
          task_type: 'local_bash',
          tool_use_id: 'tool-old',
          is_backgrounded: true
        })
      )
      run.send(
        system('task_notification', {
          task_id: 'monitor-task',
          tool_use_id: 'tool-old',
          status: 'completed'
        })
      )
    }
    run.send(toolUse('tool-monitor', 'Monitor', { command: 'watch' }))
    run.send({
      ...toolResult('tool-monitor', 'Started'),
      tool_use_result: { taskId: 'monitor-task' }
    })
    run.send(
      system('task_started', {
        task_id: 'monitor-task',
        task_type: 'local_bash',
        tool_use_id: 'tool-monitor',
        is_backgrounded: true
      })
    )
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
    ).toHaveLength(reused ? 1 : 0)
    expect(run.records().some((row) => row.membership === 'live')).toBe(true)
  }
)

it('retains pending ownership and terminal evidence without granting a partial frame live authority', async () => {
  const run = await producer()
  run.send(
    system('task_started', {
      task_id: 'reused',
      task_type: 'local_bash',
      tool_use_id: 'tool-old',
      is_backgrounded: true
    })
  )
  run.send(
    system('task_progress', {
      task_id: 'reused',
      tool_use_id: 'tool-owned',
      parent_task_id: 'owner'
    })
  )
  run.send(
    system('task_notification', {
      task_id: 'reused',
      tool_use_id: 'tool-old',
      status: 'stopped'
    })
  )
  run.send(
    system('task_started', {
      task_id: 'reused',
      task_type: 'local_bash',
      tool_use_id: 'tool-owned',
      is_backgrounded: true
    })
  )
  expect(run.records().find((row) => row.kind === 'command')).toMatchObject({
    membership: 'live',
    stoppable: true
  })
  expect(
    [...run.journalItems.values()].find(
      (row) =>
        row.body.kind === 'message' &&
        row.body.blocks.some(
          (block) => block.type === 'background-task' && block.parentToolUseId === 'tool-owned'
        )
    )
  ).toMatchObject({ agentId: 'reused' })
  run.send(
    system('task_notification', {
      task_id: 'reused',
      tool_use_id: 'tool-stopped-before-start',
      status: 'stopped'
    })
  )
  run.send(
    system('task_notification', {
      task_id: 'reused',
      tool_use_id: 'tool-owned',
      status: 'stopped'
    })
  )
  run.send(
    system('task_started', {
      task_id: 'reused',
      task_type: 'local_bash',
      tool_use_id: 'tool-stopped-before-start',
      is_backgrounded: true
    })
  )
  expect(run.records().filter((row) => row.membership === 'live')).toEqual([])
  const stoppedBody = [...run.journalItems.values()].find(
    (row) =>
      row.body.kind === 'message' &&
      row.body.blocks.some(
        (block) =>
          block.type === 'background-task' && block.parentToolUseId === 'tool-stopped-before-start'
      )
  )?.body
  expect(stoppedBody?.kind === 'message' ? stoppedBody.blocks : []).toContainEqual(
    expect.objectContaining({ parentToolUseId: 'tool-stopped-before-start', state: 'idle' })
  )
})

it.each(['alias', 'no-alias', 'partial-alias', 'known-terminal'])(
  'admits a resumed agent only when the terminal did not identify that invocation: %s',
  async (shape) => {
    const run = await producer()
    run.send(
      system('task_notification', {
        task_id: 'owner',
        status: 'stopped',
        ...(shape === 'known-terminal' ? { tool_use_id: 'spawn-owner' } : {})
      })
    )
    if (shape === 'partial-alias') {
      run.send(system('task_progress', { task_id: 'owner', tool_use_id: 'spawn-owner' }))
    }
    run.send(
      system('task_started', {
        task_id: 'owner',
        task_type: 'local_agent',
        is_backgrounded: true,
        ...(shape === 'no-alias' ? {} : { tool_use_id: 'spawn-owner' })
      })
    )
    run.send(
      system('task_started', {
        task_id: 'shell',
        task_type: 'local_bash',
        tool_use_id: 'shell-tool',
        parent_task_id: 'owner',
        is_backgrounded: true
      })
    )
    const owner = run.records().find((row) => row.kind === 'agent')
    const shell = run.records().find((row) => row.kind === 'command')
    if (shape === 'known-terminal') {
      expect(owner?.membership).not.toBe('live')
    } else {
      expect(owner).toMatchObject({ membership: 'live', stoppable: true })
      expect(shell).toMatchObject({
        membership: 'live',
        stoppable: true,
        parentChildWorkId: owner?.childWorkId
      })
    }
  }
)

it('releases an alias-less roster against reopened ownership on binding without another provider frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-parent-binding-'))
  cleanup.push(root)
  const identity = identityFor()
  const open = () => journals.open({ identity, now: () => 9000, stateDirectory: root })
  let journal = await open()
  for (const id of ['saved-shell', 'saved-only']) {
    await journal.appendItem(
      claudeBackgroundTaskIdentity(id, 1),
      claudeBackgroundTaskBody({
        type: 'background-task',
        taskId: id,
        kind: 'command',
        label: 'sleep',
        parentToolUseId: 'saved-tool',
        state: 'unverifiable',
        startedAt: 1
      }),
      {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE,
        agentId: id,
        parentAgentId: 'saved-owner',
        producerKind: 'background',
        providerParentRef: 'saved-tool'
      }
    )
  }
  const originalId = journal.snapshot().items[0]!.itemId
  await journals.closeAll()
  journal = await open()
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.sink.appendItem(
    { provider: 'claude', sessionId: 'saved-session', uuid: 'before-bind' },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Earlier queued write' }] },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const claude = fakeClaude()
  const evidence: AgentChildWorkEvidence[] = []
  const adapter = adapterAtPublishFor(
    claude,
    {},
    [],
    [],
    undefined,
    undefined,
    (_sessionId, batch) => evidence.push(...batch)
  )
  await adapter.acquire({ identity, fence: 1, spawnToken: 'binding-test', events: deferred.sink })
  const roster = () =>
    claude.connections[0]!.handlers.onMessage?.(
      system('background_tasks_changed', {
        tasks: [{ task_id: 'saved-shell', task_type: 'local_bash' }]
      })
    )
  roster()
  claude.connections[0]!.handlers.onMessage?.(
    frame({
      type: 'assistant',
      message: {
        id: 'held-assistant',
        role: 'assistant',
        content: [{ type: 'text', text: 'Later provider write' }]
      }
    })
  )
  expect(evidence.filter((edge) => edge.type === 'live')).toEqual([])
  deferred.bind({ journal, fence: 1, publish: () => {} })
  expect(await deferred.drained()).toEqual({ ok: true })
  expect(evidence).toContainEqual(
    expect.objectContaining({
      type: 'live',
      child: expect.objectContaining({
        ownerId: 'saved-owner',
        stoppable: true
      })
    })
  )
  const liveIds = evidence
    .filter((edge) => edge.type === 'live')
    .map((edge) => edge.child.handle.id)
  expect(liveIds).toContain('saved-shell')
  expect(liveIds).not.toContain('saved-only')
  const queuedMessages = journal
    .snapshot()
    .items.filter(
      (row) =>
        row.body.kind === 'message' &&
        row.body.blocks.some(
          (block) =>
            block.type === 'text' &&
            (block.text === 'Earlier queued write' || block.text === 'Later provider write')
        )
    )
  expect(queuedMessages.map((row) => row.body)).toMatchObject([
    { kind: 'message', blocks: [{ type: 'text', text: 'Earlier queued write' }] },
    { kind: 'message', blocks: [{ type: 'text', text: 'Later provider write' }] }
  ])
  expect(queuedMessages[0]!.sequence).toBeLessThan(queuedMessages[1]!.sequence)
  expect(journal.item(originalId)).toMatchObject({
    agentId: 'saved-shell',
    parentAgentId: 'saved-owner',
    providerParentRef: 'saved-tool'
  })
  expect(journal.item(originalId)?.body).toMatchObject({
    kind: 'message',
    blocks: expect.arrayContaining([
      expect.objectContaining({
        taskId: 'saved-shell',
        parentToolUseId: 'saved-tool',
        state: 'working'
      })
    ])
  })
  roster()
  expect(await deferred.drained()).toEqual({ ok: true })
  expect(
    journal
      .snapshot()
      .items.filter(
        (row) =>
          row.body.kind === 'message' &&
          row.body.blocks.some(
            (block) => block.type === 'background-task' && block.taskId === 'saved-shell'
          )
      )
  ).toHaveLength(1)
  expect(journal.snapshot().items.find((row) => row.agentId === 'saved-only')?.body).toMatchObject({
    kind: 'message',
    blocks: expect.arrayContaining([expect.objectContaining({ state: 'unverifiable' })])
  })
  const retired = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  const replacement = adapterAtPublishFor(claude)
  await replacement.acquire({
    identity,
    fence: 1,
    spawnToken: 'retired-test',
    events: retired.sink
  })
  claude.connections[1]!.handlers.onMessage?.(
    system('task_started', {
      task_id: 'retired-shell',
      task_type: 'local_bash',
      is_backgrounded: true
    })
  )
  await replacement.releaseAcquisition({ sessionId: identity.sessionId })
  retired.bind({ journal, fence: 1, publish: () => {} })
  expect(await retired.drained()).toEqual({ ok: true })
  expect(
    journal
      .snapshot()
      .items.some(
        (row) =>
          row.body.kind === 'message' &&
          row.body.blocks.some(
            (block) => block.type === 'background-task' && block.taskId === 'retired-shell'
          )
      )
  ).toBe(false)
  retired.close()
  await adapter.releaseAcquisition({ sessionId: identity.sessionId })
  deferred.close()
})
