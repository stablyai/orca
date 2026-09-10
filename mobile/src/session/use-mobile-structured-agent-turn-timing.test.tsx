import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../src/shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../src/shared/agent-session-turn-record'
import { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'

// Host clock sits an hour ahead of the client's so any leak of a host timestamp
// into the local anchor shows up as a huge offset.
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

// The submission the provider acknowledged under the key its lifecycle row cites.
const SUBMISSIONS: AgentJournalSubmission[] = [
  {
    clientMessageId: 'first',
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted',
    providerItemId: 'codex:thread:t1:0',
    reason: null,
    submittedAt: 1,
    resolvedAt: 2
  }
]

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

  it('hands settled host durations through and anchors the live counter locally, once per turn', () => {
    vi.useFakeTimers()
    vi.setSystemTime(CLIENT_NOW)
    const items = [
      user('u1', 1),
      lifecycle(
        't1',
        2,
        {
          state: 'interrupted',
          startedAt: HOST_START,
          completedAt: HOST_START + 61_000,
          userItemId: 'codex:thread:t1:0'
        },
        HOST_START + 5
      ),
      user('u2', 3),
      // The host appended the row 2.5s after it saw the turn start.
      lifecycle(
        't2',
        4,
        { state: 'running', startedAt: HOST_START + 100_000 },
        HOST_START + 102_500
      )
    ]
    const submissions = SUBMISSIONS
    act(() => {
      renderer = create(createElement(Harness, { items, submissions, turnId: 't2' }))
    })
    expect(timing?.workingStartedAt).toBe(CLIENT_NOW - 2_500)
    // The row's provider key resolves through the submission alias, not journal order.
    expect([...timing!.settledTurns]).toEqual([
      ['orca:first', { startedAt: HOST_START, workedSeconds: 61 }]
    ])

    vi.setSystemTime(CLIENT_NOW + 30_000)
    act(() =>
      renderer?.update(createElement(Harness, { items: [...items], submissions, turnId: 't2' }))
    )
    expect(timing?.workingStartedAt).toBe(CLIENT_NOW - 2_500)

    act(() => renderer?.update(createElement(Harness, { items, turnId: null })))
    expect(timing?.workingStartedAt).toBeNull()

    // With a host clock that said the turn was 35s old 5s ago, the anchor sits
    // 40s before first sight, wherever the client's absolute clock is.
    vi.setSystemTime(CLIENT_NOW + 60_000)
    const next = [
      ...items,
      user('u3', 5),
      lifecycle(
        't3',
        6,
        { state: 'running', startedAt: HOST_START + 150_000 },
        HOST_START + 150_100
      )
    ]
    act(() =>
      renderer?.update(
        createElement(Harness, {
          items: next,
          turnId: 't3',
          hostClock: { hostNow: HOST_START + 185_000, receivedAt: CLIENT_NOW + 55_000 }
        })
      )
    )
    expect(timing?.workingStartedAt).toBe(CLIENT_NOW + 60_000 - 40_000)
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
