import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { hasUnansweredStructuredAgentSessionDispatch } from '../../shared/agent-session/requests/structured-agent-session-unanswered-dispatch'
import { projectStructuredAgentSessionStatus } from '../../shared/agent-session/view/structured-agent-session-projection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './structured/journal/claude-structured-journal-translation'

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

    const taskRow = items().find((item) => item.itemId.includes('byjnee2no'))
    expect(taskRow).toBeDefined()
    const running = items().filter((item) => readAgentJournalTurn(item.body)?.state === 'running')
    expect(running).toHaveLength(1)
    expect(projected(items())).toBe('working')
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

it('keeps an alias-only owned notification idle even when its alias was forwarded at the root', () => {
  const { translator, items } = harness()
  spawnToolCall(translator)
  translator.handle(
    systemFrame('owned-start', {
      subtype: 'task_started',
      task_id: 'owned',
      tool_use_id: TOOL,
      parent_task_id: 'owner',
      task_type: 'local_bash',
      is_backgrounded: true
    })
  )
  settleTurn(translator)
  translator.handle(
    systemFrame('owned-terminal', {
      subtype: 'task_notification',
      tool_use_id: TOOL,
      status: 'completed',
      summary: 'Finished child'
    })
  )
  expect(items().find((item) => item.itemId.includes('owned'))?.body).toMatchObject({
    kind: 'message',
    blocks: expect.arrayContaining([
      expect.objectContaining({ type: 'background-task', taskId: 'owned', state: 'done' })
    ])
  })
  expect(projected(items())).toBe('idle')
  translator.dispose()
})

it('keeps owned terminal overflow writes idle without a retained row invocation', () => {
  const { translator, items } = harness()
  for (let index = 0; index < 65; index += 1) {
    translator.handle(
      systemFrame(`owned-start-${index}`, {
        subtype: 'task_started',
        task_id: `owned-${index}`,
        parent_task_id: 'owner',
        task_type: 'local_bash',
        is_backgrounded: true
      })
    )
  }
  settleTurn(translator)
  translator.handle(
    systemFrame('overflow-owned-patch', {
      subtype: 'task_updated',
      task_id: 'owned-64',
      patch: { status: 'failed' }
    })
  )
  translator.handle(
    systemFrame('overflow-owned-orphan', {
      subtype: 'task_notification',
      task_id: 'owned-terminal-only',
      parent_task_id: 'owner',
      status: 'completed'
    })
  )
  const terminal = items().filter(
    (item) =>
      item.body.kind === 'message' &&
      item.body.blocks.some(
        (block) =>
          block.type === 'background-task' &&
          ['owned-64', 'owned-terminal-only'].includes(block.taskId)
      )
  )
  expect(terminal).toHaveLength(2)
  expect(projected(items())).toBe('idle')
  translator.dispose()
})
