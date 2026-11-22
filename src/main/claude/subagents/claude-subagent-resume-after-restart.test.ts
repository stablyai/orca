import { readTestJournalItems } from '../../native-chat/agent-session-journal/journal-observation.test-support'
import {
  PARENT_TASK_STOP,
  blockOf
} from '../background-tasks/claude-background-task-row-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from '../structured/journal/claude-structured-journal-translation'
import { testEventSinkLogging } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'
import { StructuredAgentSessionSnapshotRoutes } from '../../native-chat/agent-session-wire/host/structured-agent-session-snapshot-routes'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

// Captured restart order: resumed frames retain original spawn IDs while announcements name new resume calls.

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

async function acquire(journal: AgentSessionJournal, delayed = false) {
  const logging = testEventSinkLogging()
  const deferred = createDeferredStructuredAgentSessionEventSink(logging)
  await deferred.followSnapshots(
    new StructuredAgentSessionSnapshotRoutes(logging.logger).observe('orca-session', journal)
  )
  const translator = createClaudeJournalTranslator({ sink: deferred.sink, coalesceMs: 0 })
  const bind = () => deferred.bind({ journal, fence: 1, publish: () => {} })
  if (!delayed) {
    bind()
  }
  const settle = async (): Promise<void> => {
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
  }
  const exit = async (): Promise<void> => {
    translator.handle({ type: 'ended', sessionId: 'orca-session', reason: 'closed' })
    await settle()
    translator.dispose()
    deferred.close()
  }
  return { translator, bind, settle, exit }
}

const proseRow = async (
  journal: AgentSessionJournal,
  text: string
): Promise<AgentJournalRenderItem | undefined> =>
  (await readTestJournalItems(journal)).find(
    (item) =>
      item.body.kind === 'message' &&
      item.body.blocks.some((block) => block.type === 'text' && block.text === text)
  )

describe('a Claude subagent resumed after its provider restarted', () => {
  it.each(['terminal-only', 'roster-first', 'unbound-roster-first', 'parent-omitting-roster'])(
    'retains one owned shell across close/reopen: %s',
    async (order) => {
      let journal = await openJournal()
      const first = await acquire(journal)
      first.translator.handle(userTurn('parent-task-turn'))
      // Contract: a parentless admission can learn ownership from a later roster without a body change.
      first.translator.handle(
        frame({ ...PARENT_TASK_STOP[3]!.frame, parent_task_id: undefined, tool_use_id: undefined })
      )
      await first.settle()
      const beforeOwnership = (await readTestJournalItems(journal)).find(
        (item) => blockOf(item.body)?.taskId === 'shell-child'
      )
      expect(beforeOwnership?.agentId).toBeUndefined()
      first.translator.handle(frame(PARENT_TASK_STOP[2]!.frame))
      await first.settle()
      expect(await journal.reads.item(beforeOwnership!.itemId)).toMatchObject({
        agentId: 'shell-child',
        parentAgentId: 'agent-parent'
      })
      first.translator.handle(frame(PARENT_TASK_STOP[3]!.frame))
      await first.settle()
      const shell = (await readTestJournalItems(journal)).find(
        (item) => blockOf(item.body)?.taskId === 'shell-child'
      )
      expect(shell).toMatchObject({
        agentId: 'shell-child',
        parentAgentId: 'agent-parent',
        producerKind: 'background',
        providerParentRef: 'toolu_shell'
      })
      await first.exit()
      expect(blockOf((await journal.reads.item(shell!.itemId))?.body)?.state).toBe('unverifiable')
      await journals.closeAll()

      journal = await openJournal()
      const delayed = order === 'unbound-roster-first'
      const resumed = await acquire(journal, delayed)
      if (!delayed) {
        expect(resumed.translator.childTaskParent?.('shell-child')).toBe('agent-parent')
      }
      if (order === 'parent-omitting-roster') {
        resumed.translator.handle(
          frame({
            type: 'system',
            subtype: 'background_tasks_changed',
            tasks: [{ task_id: 'shell-child', task_type: 'local_bash' }]
          })
        )
        await resumed.settle()
        expect(await journal.reads.item(shell!.itemId)).toMatchObject({
          parentAgentId: 'agent-parent'
        })
        expect(blockOf((await journal.reads.item(shell!.itemId))?.body)?.state).toBe('working')
      } else if (order !== 'terminal-only') {
        resumed.translator.handle(frame(PARENT_TASK_STOP[2]!.frame))
        resumed.translator.handle(frame(PARENT_TASK_STOP[3]!.frame))
      }
      if (delayed) {
        resumed.bind()
      }
      // Contract: a terminal revision must retain saved ownership even without a repeated start.
      resumed.translator.handle(frame(PARENT_TASK_STOP[8]!.frame))
      await resumed.settle()
      const shells = (await readTestJournalItems(journal)).filter(
        (item) => blockOf(item.body)?.taskId === 'shell-child'
      )
      expect(shells).toHaveLength(1)
      expect(shells[0]).toMatchObject({
        itemId: shell!.itemId,
        agentId: 'shell-child',
        parentAgentId: 'agent-parent',
        producerKind: 'background',
        providerParentRef: 'toolu_shell'
      })
      expect(blockOf(shells[0]?.body)?.state).toBe('idle')
      await resumed.exit()
    }
  )

  it('keeps the canonical id its first run was given, so one child stays one child', async () => {
    const journal = await openJournal()

    const first = await acquire(journal)
    first.bind()
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
    expect(await proseRow(journal, 'A reads the rig recipes')).toMatchObject({ agentId: 'agent-a' })

    // The acquisition's saved answers apply before its sink binds.
    const second = await acquire(journal)
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
    // Preserve captured interleaving to catch cross-child identity swaps.
    second.translator.handle(childSays('a-2', 'toolu_spawn_a', 'A restarts the receiver'))
    second.translator.handle(childSays('b-2', 'toolu_spawn_b', 'B checks the rig'))
    second.bind()
    await second.settle()

    expect(await proseRow(journal, 'A restarts the receiver')).toMatchObject({
      agentId: 'agent-a',
      providerParentRef: 'toolu_spawn_a',
      producerKind: 'agent'
    })
    expect(await proseRow(journal, 'B checks the rig')).toMatchObject({
      agentId: 'agent-b',
      providerParentRef: 'toolu_spawn_b'
    })
    expect((await proseRow(journal, 'A reads the rig recipes'))?.attempt).toBeUndefined()
    expect((await proseRow(journal, 'A restarts the receiver'))?.attempt).toBe(2)
    expect((await proseRow(journal, 'B checks the rig'))?.attempt).toBe(2)
    await second.exit()
  })
})
