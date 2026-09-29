// A typed background-task row is provider output. Journaling one must reopen a
// turn the provider resumed on its own, or the session renders the row while
// the projector — and so the sidebar row and the chat indicator — read idle.
//
// This is the same failure shape as the reported incident: a `result` settles
// the turn, then a background task reports in and wakes the agent.

import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  hasUnansweredStructuredAgentSessionDispatch,
  projectStructuredAgentSessionStatus
} from '../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const SESSION = 'claude-session'
const TOOL = 'toolu_fwd'

function harness() {
  const appended: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => appended.push({ identity, body }),
    appendTombstone: () => {},
    publish: vi.fn()
  }
  const translator = createClaudeJournalTranslator({ sink, fallbackIdPrefix: 'test' })
  const items = (): AgentJournalRenderItem[] => {
    const byKey = new Map<string, AgentJournalRenderItem>()
    appended.forEach(({ identity, body }, index) => {
      const key = agentJournalItemKey(identity)
      const existing = byKey.get(key)
      byKey.set(key, {
        itemId: key,
        revision: (existing?.revision ?? 0) + 1,
        body,
        sequence: existing?.sequence ?? index,
        observedAt: index
      })
    })
    return [...byKey.values()].sort((a, b) => a.sequence - b.sequence)
  }
  return { translator, items, appended }
}

function projected(items: readonly AgentJournalRenderItem[]): string {
  expect(hasUnansweredStructuredAgentSessionDispatch([], null)).toBe(false)
  return projectStructuredAgentSessionStatus(items, [], null)
}

function systemFrame(uuid: string, fields: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: { type: 'system', uuid, session_id: SESSION, ...fields }
  }
}

/** The assistant turn that invokes the spawn tool, which admission requires. */
function spawnToolCall(translator: ReturnType<typeof harness>['translator']) {
  translator.handle({
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'assistant',
      uuid: 'a1',
      session_id: SESSION,
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: TOOL, name: 'Bash', input: { command: 'wait' } }]
      }
    }
  })
}

function settleTurn(translator: ReturnType<typeof harness>['translator']) {
  translator.handle({
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'result',
      subtype: 'success',
      uuid: 'r1',
      session_id: SESSION,
      parent_tool_use_id: null,
      duration_ms: 1000
    }
  })
}

describe('a typed background-task row opens the turn it resumes', () => {
  it('reports working, not idle, when a task notification wakes the agent', () => {
    const { translator, items } = harness()
    spawnToolCall(translator)
    translator.handle(
      systemFrame('s1', {
        subtype: 'task_started',
        task_id: 'byjnee2no',
        tool_use_id: TOOL,
        task_type: 'local_bash',
        description: 'Wait for the verification verdict',
        is_backgrounded: true
      })
    )
    settleTurn(translator)
    // The turn is settled: this is the state the reported session was in.
    expect(projected(items())).toBe('idle')

    translator.handle(
      systemFrame('s2', {
        subtype: 'task_notification',
        task_id: 'byjnee2no',
        tool_use_id: TOOL,
        status: 'failed',
        summary: 'Background command "Wait" failed with exit code 1'
      })
    )

    // The typed row is journaled...
    // `agentJournalItemKey` percent-encodes the ':', so the durable row reads
    // `orca:claude-background-task%3Abyjnee2no`.
    const taskRow = items().find((item) => item.itemId.includes('byjnee2no'))
    expect(taskRow).toBeDefined()
    // ...and it opened a turn, so the session does not read idle beside it.
    const running = items().filter((item) => readAgentJournalTurn(item.body)?.state === 'running')
    expect(running).toHaveLength(1)
    expect(projected(items())).toBe('working')
  })

  it('does not reopen a completed turn for a late task revision', () => {
    const { translator, items } = harness()
    spawnToolCall(translator)
    translator.handle(
      systemFrame('s1', {
        subtype: 'task_started',
        task_id: 'late-revision',
        tool_use_id: TOOL,
        task_type: 'local_bash',
        description: 'Wait for the verification verdict',
        is_backgrounded: true
      })
    )
    translator.handle(
      systemFrame('s2', {
        subtype: 'task_notification',
        task_id: 'late-revision',
        tool_use_id: TOOL,
        status: 'completed',
        summary: 'first run finished'
      })
    )
    settleTurn(translator)
    expect(projected(items())).toBe('idle')

    translator.handle(
      systemFrame('s3', {
        subtype: 'task_progress',
        task_id: 'late-revision',
        usage: { total_tokens: 99 }
      })
    )

    expect(projected(items())).toBe('idle')
  })

  it('does not reopen a completed turn when an overflow terminal row is enriched', () => {
    const { translator, items } = harness()
    for (let index = 0; index < 64; index += 1) {
      translator.handle(
        systemFrame(`start-${index}`, {
          subtype: 'task_started',
          task_id: `live-${index}`,
          task_type: 'local_bash',
          is_backgrounded: true
        })
      )
    }
    translator.handle(
      systemFrame('overflow-start', {
        subtype: 'task_started',
        task_id: 'overflow-turn',
        task_type: 'local_bash',
        is_backgrounded: true
      })
    )
    translator.handle(
      systemFrame('overflow-update', {
        subtype: 'task_updated',
        task_id: 'overflow-turn',
        patch: { status: 'failed' }
      })
    )
    settleTurn(translator)
    expect(projected(items())).toBe('idle')

    translator.handle(
      systemFrame('overflow-notification', {
        subtype: 'task_notification',
        task_id: 'overflow-turn',
        status: 'stopped',
        summary: 'No completion record was found'
      })
    )

    expect(projected(items())).toBe('idle')
  })
})
