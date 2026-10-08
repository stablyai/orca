import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import {
  agentJournalTurnForkPoint,
  readAgentJournalTurn
} from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  CAPTURED_CLAUDE_TURNS,
  type CapturedClaudeFrame
} from './claude-turn-fork-point-captures.test-fixture'

const SESSION = 'claude-session'

function content(frame: CapturedClaudeFrame): unknown[] {
  if (frame.block === 'tool_use') {
    return [{ type: 'tool_use', id: `toolu_${frame.uuid}`, name: 'Bash', input: {} }]
  }
  if (frame.block === 'tool_result') {
    return [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }]
  }
  return frame.block === 'thinking'
    ? [{ type: 'thinking', thinking: 'hm' }]
    : [{ type: 'text', text: 'text' }]
}

/** The events the adapter hands the translator for a captured run. A send echo opens a turn only
 *  as its request cycle's first work; one that lands mid-cycle was folded into the running turn. */
function events(frames: readonly CapturedClaudeFrame[]): ClaudeStructuredSessionEvent[] {
  let cycleWorked = false
  return frames.map((frame, index) => {
    const base = { type: 'message' as const, sessionId: 'orca-session', observedAt: 1_000 + index }
    if (frame.type === 'init') {
      cycleWorked = false
      return {
        ...base,
        message: { type: 'system', subtype: 'init', uuid: frame.uuid, session_id: SESSION }
      }
    }
    if (frame.type === 'result') {
      return {
        ...base,
        message: {
          type: 'result',
          subtype: 'success',
          uuid: frame.uuid,
          session_id: SESSION,
          is_error: frame.isError === true,
          result: ''
        }
      }
    }
    const startsTurn = frame.replay === true && !cycleWorked
    cycleWorked = true
    return {
      ...base,
      ...(startsTurn ? { startsTurn } : {}),
      message: {
        type: frame.type,
        uuid: frame.uuid,
        session_id: SESSION,
        parent_tool_use_id: frame.parent ?? null,
        message: { role: frame.type, content: content(frame) }
      }
    }
  })
}

/** The fork point each ended turn of a captured run is left with, in the order the turns ended. */
function forkPoints(frames: readonly CapturedClaudeFrame[]): (string | null)[] {
  const bodies = new Map<string, AgentJournalItemBody>()
  const order: string[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => {
      const key = JSON.stringify(identity)
      if (!bodies.has(key)) {
        order.push(key)
      }
      bodies.set(key, body)
    },
    appendTombstone: vi.fn(),
    publish: vi.fn()
  }
  const translator = createClaudeJournalTranslator({ sink })
  for (const event of events(frames)) {
    translator.handle(event)
  }
  return order.flatMap((key) => {
    const turn = readAgentJournalTurn(bodies.get(key))
    return turn ? [agentJournalTurnForkPoint('claude', turn)] : []
  })
}

describe('where a fork of a Claude turn cuts', () => {
  it('is the last entry the assistant wrote, across a message folded into the turn', () => {
    expect(forkPoints(CAPTURED_CLAUDE_TURNS.steered)).toEqual([
      '934a097e-026e-426c-bacf-379a77c4e53f',
      '816adc3e-1a52-4f66-96be-8dac8405ae8a'
    ])
  })

  it('gives a turn the provider woke itself for a cut of its own, after a subagent ran', () => {
    expect(forkPoints(CAPTURED_CLAUDE_TURNS.subagent)).toEqual([
      'd0b39adb-ab68-400e-a6f1-77682740ee9e',
      '73d44e6e-52ae-40fd-b4e4-cf225c955d67',
      '8bdb741b-8423-4c73-9185-733d17b922fe'
    ])
  })

  it('is absent on a stopped turn, which the provider still reports as a success', () => {
    expect(forkPoints(CAPTURED_CLAUDE_TURNS.interrupted)).toEqual([
      null,
      '6321f4c4-6600-4556-a998-61372eafe927'
    ])
  })
})
