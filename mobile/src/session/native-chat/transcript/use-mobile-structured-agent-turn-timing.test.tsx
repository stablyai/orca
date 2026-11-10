import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../../../src/shared/agent-session/lifecycle/agent-session-turn-record'
import { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'

// Skew the host clock by an hour so unconverted timestamp leakage is obvious.
const HOST_START = 3_600_000_000
const CLIENT_NOW = 12_345_000

function user(itemId: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: HOST_START + sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }] }
  }
}

function lifecycle(
  turnId: string,
  sequence: number,
  turn: Omit<AgentJournalTurnLifecycle, 'turnId'>,
  observedAt: number
): AgentJournalRenderItem {
  return {
    itemId: `lifecycle-${turnId}`,
    revision: 1,
    sequence,
    observedAt,
    body: agentJournalTurnBody({ turnId, ...turn })
  }
}

type Timing = ReturnType<typeof useMobileStructuredAgentTurnTiming>
const NO_SUBMISSIONS: readonly AgentJournalSubmission[] = []

describe('useMobileStructuredAgentTurnTiming', () => {
  let renderer: ReactTestRenderer | null = null
  let timing: Timing | null = null

  function Harness({
    items,
    submissions = NO_SUBMISSIONS,
    turnId,
    hostClock
  }: {
    items: readonly AgentJournalRenderItem[]
    submissions?: readonly AgentJournalSubmission[]
    turnId: string | null
    hostClock?: { hostNow: number; receivedAt: number }
  }): null {
    timing = useMobileStructuredAgentTurnTiming({ items, submissions, hostClock }, turnId)
    return null
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    timing = null
    vi.useRealTimers()
  })

  it('leaves the anchor null when an older host records no start', () => {
    vi.useFakeTimers()
    vi.setSystemTime(CLIENT_NOW)
    const items = [user('u1', 1), lifecycle('t1', 2, { state: 'running' }, HOST_START)]
    act(() => {
      renderer = create(createElement(Harness, { items, turnId: 't1' }))
    })
    expect(timing?.workingStartedAt).toBeNull()
    expect(timing?.settledTurns.size).toBe(0)
  })
})
