// Captured 2026-09-13 (962e6f25…/3d214e6f…): provider-resumed work incorrectly stayed idle.

import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  legacyAgentJournalTurnStatusBody,
  readAgentJournalTurn
} from '../../shared/agent-session-turn-record'
import { selectStructuredAgentSettledTurns } from '../../shared/structured-agent-session-turn-timing'
import {
  hasUnansweredStructuredAgentSessionDispatch,
  projectStructuredAgentSessionStatus,
  projectStructuredAgentSessionStatusSummary
} from '../../shared/structured-agent-session-projection'
import { statusStructuredAgentSessionToolCall } from '../../shared/structured-agent-session-live-turn'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const SESSION = 'claude-session'

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

function frame(
  type: 'assistant' | 'user',
  uuid: string,
  content: unknown[],
  parentToolUseId: string | null = null
) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    ...(type === 'user' && parentToolUseId === null ? { startsTurn: true as const } : {}),
    message: {
      type,
      uuid,
      session_id: SESSION,
      parent_tool_use_id: parentToolUseId,
      message: { role: type, content }
    }
  }
}

/** Captured provider wake-up has no dispatch waiter, so it cannot open a turn. */
function taskNotification(uuid: string) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'user',
      uuid,
      session_id: SESSION,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<task-notification><task-id>bfnmj08v6</task-id>' }]
      }
    }
  }
}

function textDelta(uuid: string, messageId: string, text: string) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'stream_event',
      uuid,
      session_id: SESSION,
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      message: { id: messageId }
    }
  }
}

function streamMessageStart(uuid: string, parentToolUseId: string | null = null) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'stream_event',
      uuid,
      session_id: SESSION,
      parent_tool_use_id: parentToolUseId,
      event: { type: 'message_start', message: { id: `msg-${uuid}`, role: 'assistant' } }
    }
  }
}

function result(uuid: string, parentToolUseId: string | null = null, durationMs = 322_937) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'result',
      subtype: 'success',
      uuid,
      session_id: SESSION,
      parent_tool_use_id: parentToolUseId,
      duration_ms: durationMs
    }
  }
}

function projected(items: readonly AgentJournalRenderItem[]): string {
  // No pending dispatch can mask the false-idle regression.
  expect(hasUnansweredStructuredAgentSessionDispatch([], null)).toBe(false)
  return projectStructuredAgentSessionStatus(items, [], null)
}

describe('a Claude turn the provider resumed on its own', () => {
  it('reports working while the agent runs tool calls after a result settled the turn', () => {
    const { translator, items } = harness()

    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    expect(projected(items())).toBe('working')

    translator.handle(result('r1'))
    expect(projected(items())).toBe('idle')

    translator.handle(taskNotification('n1'))
    translator.handle(frame('assistant', 'a1', [{ type: 'text', text: 'Back on it.' }]))
    expect(projected(items())).toBe('working')

    translator.handle(
      frame('assistant', 'a2', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'rg foo' } }
      ])
    )
    expect(projected(items())).toBe('working')

    translator.handle(result('r2'))
    expect(projected(items())).toBe('idle')
  })

  it('gives the resumed turn its own record, anchored away from the preceding user row', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(result('r1'))
    translator.handle(frame('assistant', 'a1', [{ type: 'text', text: 'Back on it.' }]))

    const turns = items().flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn ? [turn] : []
    })
    expect(turns.map((turn) => turn.state)).toEqual(['completed', 'running'])
    expect(turns[1]?.turnId).toBe('a1')
    expect(turns[1]?.userItemId).toBe('legacy:claude:claude-session:turn-lifecycle%3Aa1')
  })

  it('does not replace the preceding prompt timing with provider-resumed work', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(result('r1', null, 1_000))
    translator.handle(frame('assistant', 'a1', [{ type: 'text', text: 'Back on it.' }]))
    translator.handle(result('r2', null, 9_000))

    const translatedItems = items()
    const originalTurn = translatedItems
      .map((item) => readAgentJournalTurn(item.body))
      .find((turn) => turn?.turnId === 'u1')
    expect(originalTurn?.userItemId).toBeDefined()
    if (!originalTurn?.userItemId) {
      throw new Error('expected the original turn to name its user row')
    }
    const userItem: AgentJournalRenderItem = {
      itemId: originalTurn.userItemId,
      revision: 1,
      sequence: -1,
      observedAt: 0,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
    }
    const currentItems = [userItem, ...translatedItems]
    expect(selectStructuredAgentSettledTurns(currentItems).get(userItem.itemId)).toMatchObject({
      workedSeconds: 1
    })

    const legacyItems = currentItems.map((item) => {
      const turn = readAgentJournalTurn(item.body)
      return item.body.kind === 'turn' && turn
        ? { ...item, body: legacyAgentJournalTurnStatusBody(turn, item.itemId) }
        : item
    })
    expect(selectStructuredAgentSettledTurns(legacyItems).get(userItem.itemId)).toMatchObject({
      workedSeconds: 1
    })
  })

  it('leaves a settled turn settled when only a subagent is still producing', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(result('r1'))

    translator.handle(streamMessageStart('child-start', 'toolu_parent'))
    expect(projected(items())).toBe('idle')
  })

  it('does not reopen a turn that is already running', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(frame('assistant', 'a1', [{ type: 'text', text: 'one' }]))
    translator.handle(frame('assistant', 'a2', [{ type: 'text', text: 'two' }]))

    const running = items().filter((item) => readAgentJournalTurn(item.body)?.state === 'running')
    expect(running).toHaveLength(1)
    expect(readAgentJournalTurn(running[0]!.body)?.turnId).toBe('u1')
    expect(projected(items())).toBe('working')
  })

  it('reports the first tool call of a resumed turn as the live tool', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    // Prose makes the original session listable.
    translator.handle(frame('assistant', 'a0', [{ type: 'text', text: 'Launched it.' }]))
    translator.handle(result('r1'))

    // The turn record must precede its first tool row for turn-scoped readers.
    translator.handle(
      frame('assistant', 'a1', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'rg foo' } }
      ])
    )

    expect(projected(items())).toBe('working')
    expect(statusStructuredAgentSessionToolCall(items())?.name).toBe('Bash')
    expect(projectStructuredAgentSessionStatusSummary(items(), [], null).toolName).toBe('Bash')
  })

  it('leaves the turn running when a nested result settles a child', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(frame('assistant', 'a0', [{ type: 'text', text: 'working on it' }]))

    // Synthetic nested result: no live capture; nested output must not settle the root turn.
    translator.handle(result('r-child', 'toolu_parent'))
    expect(projected(items())).toBe('working')

    translator.handle(result('r-root'))
    expect(projected(items())).toBe('idle')
  })

  it('never opens a turn from a frame that arrives after the session ended', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(frame('assistant', 'a0', [{ type: 'text', text: 'on it' }]))
    translator.handle({ type: 'ended', sessionId: 'orca-session', reason: 'exit', observedAt: 1 })
    expect(projected(items())).toBe('idle')

    translator.handle(streamMessageStart('late-start'))
    expect(projected(items())).toBe('idle')
  })

  it('does not let provider chatter resume a turn the provider failed', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(frame('assistant', 'a0', [{ type: 'text', text: 'on it' }]))
    translator.handle({
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'result',
        subtype: 'error',
        uuid: 'r-fail',
        session_id: SESSION,
        parent_tool_use_id: null,
        is_error: true
      }
    })
    expect(projected(items())).toBe('idle')

    translator.handle(frame('assistant', 'a1', [{ type: 'text', text: 'still talking' }]))
    expect(projected(items())).toBe('idle')

    translator.handle(frame('user', 'u2', [{ type: 'text', text: 'again' }]))
    expect(projected(items())).toBe('working')
  })

  it('reports working from the first streamed delta of a resumed turn', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(frame('assistant', 'a0', [{ type: 'text', text: 'on it' }]))
    translator.handle(result('r1'))
    expect(projected(items())).toBe('idle')

    translator.handle(textDelta('d1', 'msg-1', 'Back '))
    translator.handle(textDelta('d2', 'msg-1', 'on it.'))
    expect(projected(items())).toBe('working')
  })

  it('opens before a resumed stream produces its first content delta', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(result('r1'))

    translator.handle(streamMessageStart('message-start-1'))

    expect(projected(items())).toBe('working')
    expect(readAgentJournalTurn(items().at(-1)?.body)?.turnId).toBe('message-start-1')
    expect(items().some((item) => item.body.kind === 'status')).toBe(false)
  })

  it('opens before journaling substantive fallback output', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(result('r1'))

    translator.handle(
      frame('assistant', 'a1', [{ type: 'future_content', message: 'new provider output' }])
    )

    const resumed = items().slice(-2)
    expect(readAgentJournalTurn(resumed[0]?.body)?.state).toBe('running')
    expect(resumed[1]?.body).toMatchObject({
      kind: 'status',
      providerFrame: { kind: 'message:assistant:content:future_content' }
    })
    expect(projected(items())).toBe('working')
  })

  it('does not open a turn for an empty assistant placeholder', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(result('r1'))

    translator.handle(frame('assistant', 'empty-1', []))

    expect(projected(items())).toBe('idle')
    expect(items().at(-1)?.body).toMatchObject({
      kind: 'status',
      providerFrame: { kind: 'message:assistant:empty' }
    })
  })

  it('still reports a nested result failure even though it settles no turn', () => {
    const { translator, items, appended } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(frame('assistant', 'a0', [{ type: 'text', text: 'on it' }]))
    const before = appended.length
    translator.handle({
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'result',
        subtype: 'error',
        uuid: 'r-child-fail',
        session_id: SESSION,
        parent_tool_use_id: 'toolu_parent',
        is_error: true,
        result: 'child blew up'
      }
    })
    expect(projected(items())).toBe('working')
    expect(appended.length).toBeGreaterThan(before)
  })

  it('keeps the failure latch set when a later root result succeeds', () => {
    const { translator, items } = harness()
    translator.handle(frame('user', 'u1', [{ type: 'text', text: 'go' }]))
    translator.handle(frame('assistant', 'a0', [{ type: 'text', text: 'on it' }]))
    translator.handle({
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'result',
        subtype: 'error',
        uuid: 'r-fail',
        session_id: SESSION,
        parent_tool_use_id: null,
        is_error: true
      }
    })
    translator.handle(result('r-late-ok'))
    translator.handle(frame('assistant', 'a1', [{ type: 'text', text: 'still talking' }]))
    expect(projected(items())).toBe('idle')
  })
})
