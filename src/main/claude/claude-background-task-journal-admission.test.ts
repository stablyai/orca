// What Claude's background-task channel actually guarantees about journal admission.
//
// Codex proves its guarantee structurally: `emit` refuses to observe or notify until
// `translator.handle` returns an accepted admission. Claude has no admission result to
// check, so copying that callback ordering would have been an assumption. These tests
// establish the two properties the host child producer really depends on, and the one
// that does NOT hold — which is why the canonical child collection is keyed on the
// background-task channel rather than on transcript rows.

import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  tick
} from './claude-structured-session-test-support'

const FORWARDED_TOOL = 'tool-forwarded'

async function harness() {
  const order: string[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: vi.fn(() => {
      order.push('journal')
    }),
    appendTombstone: () => {},
    publish: () => {}
  }
  const claude = fakeClaude()
  const adapter = adapterFor(
    claude,
    {},
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    (_sessionId, state) => {
      order.push(`notify:${state?.tasks?.length ?? 0}`)
    }
  )
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: sink
  })
  const send = async (message: Record<string, unknown>): Promise<void> => {
    claude.connections[0]?.handlers.onMessage?.(message)
    await tick()
  }
  return { order, adapter, send }
}

function assistantToolUse(toolUseId: string): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: `assistant-${toolUseId}`,
    session_id: PROVIDER_SESSION_ID,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'wait' } }]
    }
  }
}

function taskStarted(taskId: string, toolUseId: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_started',
    session_id: PROVIDER_SESSION_ID,
    uuid: `uuid-${taskId}`,
    task_id: taskId,
    tool_use_id: toolUseId,
    task_type: 'local_bash',
    description: 'Wait for the verification verdict',
    is_backgrounded: true
  }
}

describe('Claude background-task journal admission', () => {
  it('journals a task row before it announces that task to the host', async () => {
    const { order, adapter, send } = await harness()
    await send(assistantToolUse(FORWARDED_TOOL))
    order.length = 0

    await send(taskStarted('task-1', FORWARDED_TOOL))

    const notified = order.findIndex((entry) => entry.startsWith('notify:'))
    expect(notified).toBeGreaterThanOrEqual(0)
    // The guarantee the producer relies on: the durable write for this frame has already
    // run when the host is told, so the collection never leads the journal.
    expect(order.indexOf('journal')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('journal')).toBeLessThan(notified)
    await adapter.closeAll()
  })

  it('still announces a task whose spawning tool never reached the transcript', async () => {
    const { order, adapter, send } = await harness()
    order.length = 0

    // `isForwardedParentTool` declines a transcript row here on purpose: a top-level row
    // would claim an invocation the user never saw.
    await send(taskStarted('task-nested', 'tool-never-forwarded'))

    expect(order).toContain('notify:1')
    // So "the host was told" does NOT imply "a transcript row exists". A producer that
    // ingested journal items would silently lose this child; one keyed on the
    // background-task channel keeps it.
    expect(order).not.toContain('journal')
    await adapter.closeAll()
  })

  it('agrees with the snapshot the background-task channel re-reads', async () => {
    const { adapter, send } = await harness()
    await send(assistantToolUse(FORWARDED_TOOL))
    await send(taskStarted('task-1', FORWARDED_TOOL))

    // The channel answers snapshots from `adapter.backgroundTaskState`, not from the
    // callback payload; a producer fed by either must see the same roster.
    const snapshot = adapter.backgroundTaskState?.(identityFor().sessionId)
    expect(snapshot?.tasks?.map((task) => task.id)).toEqual(['task-1'])
    expect(snapshot?.supportsTaskStop).toBe(true)
    await adapter.closeAll()
  })
})
