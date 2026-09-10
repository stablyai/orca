import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionPtyWriteRefusal } from '../../../shared/agent-session-pty-write-admission'
import {
  decideStructuredPointerDelivery,
  isSettledNativeOwner,
  retainReasonForDispatch,
  retainWaitsForJournalEdge,
  structuredDispatchDelivered,
  structuredSessionGateFacts
} from './structured-session-pointer-delivery'

function refusal(
  overrides: Partial<AgentSessionPtyWriteRefusal> = {}
): AgentSessionPtyWriteRefusal {
  return {
    code: 'agent_session_conflict',
    sessionId: 'session-1',
    ownerRuntimeKind: 'native',
    handoffStage: null,
    ownerPid: 4242,
    runtimeFence: 7,
    ...overrides
  }
}

function statusItem(
  turnLifecycle: { turnId: string; state: 'running' } | undefined
): AgentJournalRenderItem {
  return {
    itemId: `item-${turnLifecycle?.turnId ?? 'plain'}`,
    revision: 1,
    body: { kind: 'status', text: 'working', ...(turnLifecycle ? { turnLifecycle } : {}) }
  } as unknown as AgentJournalRenderItem
}

/** A turn's worth of ordinary transcript: no lifecycle row, which is what a settled turn leaves. */
function transcript(count: number): AgentJournalRenderItem[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      ({
        itemId: `tool-${index}`,
        revision: 1,
        body: { kind: 'tool-call', name: 'Bash', input: {}, state: 'completed' }
      }) as unknown as AgentJournalRenderItem
  )
}

function pendingApproval(): AgentJournalRenderItem {
  return {
    itemId: 'approval-1',
    revision: 1,
    body: { kind: 'approval', title: 'run it?', resolution: { state: 'pending' } }
  } as unknown as AgentJournalRenderItem
}

const IDLE = { turnRunning: false, awaitingHuman: false }

describe('structured pointer owner admission', () => {
  it('accepts only a settled native owner', () => {
    expect(isSettledNativeOwner(refusal())).toBe(true)
  })

  it('refuses a tui owner', () => {
    expect(isSettledNativeOwner(refusal({ ownerRuntimeKind: 'tui' }))).toBe(false)
  })

  it('refuses a native owner that is mid-handoff, so a to-tui takeover is not raced', () => {
    expect(isSettledNativeOwner(refusal({ handoffStage: 'recovering' }))).toBe(false)
  })

  it('refuses a reconciling refusal even though it names a native owner', () => {
    expect(isSettledNativeOwner(refusal({ code: 'execution_owner_reconciling' }))).toBe(false)
  })
})

describe('structured session gate facts', () => {
  it('reads an empty journal as idle', () => {
    expect(structuredSessionGateFacts([])).toEqual(IDLE)
  })

  it('reads a running turn as busy', () => {
    expect(
      structuredSessionGateFacts([statusItem({ turnId: 'turn-1', state: 'running' })])
    ).toEqual({ turnRunning: true, awaitingHuman: false })
  })

  it('reads a tombstoned turn as idle, since settlement removes the running row', () => {
    // A healthy completed turn leaves no turnLifecycle row behind at all.
    expect(structuredSessionGateFacts([statusItem(undefined)])).toEqual(IDLE)
  })

  it('reads a worker that has finished a long turn as idle, however much history it has', () => {
    // The steady state of a working agent: plenty of items, no lifecycle row anywhere. Answering
    // this from a bounded tail page cannot distinguish it from a running turn whose lifecycle row
    // was pushed off the end, which is why the facts come off the fully reduced timeline.
    expect(structuredSessionGateFacts(transcript(120))).toEqual(IDLE)
  })

  it('sees a pending approval that scrolled out of any tail window', () => {
    expect(structuredSessionGateFacts([pendingApproval(), ...transcript(120)])).toEqual({
      turnRunning: false,
      awaitingHuman: true
    })
  })

  it('reports a prompt raised mid-turn as both busy and awaiting a human', () => {
    expect(
      structuredSessionGateFacts([
        statusItem({ turnId: 'turn-1', state: 'running' }),
        pendingApproval()
      ])
    ).toEqual({ turnRunning: true, awaitingHuman: true })
  })
})

describe('decideStructuredPointerDelivery', () => {
  it('delivers to a settled, attached, idle session', () => {
    expect(decideStructuredPointerDelivery({ refusal: refusal(), session: IDLE })).toEqual({
      deliver: true
    })
  })

  it('retains when the session is not attached on this host', () => {
    expect(decideStructuredPointerDelivery({ refusal: refusal(), session: null })).toEqual({
      deliver: false,
      retain: 'session-not-attached'
    })
  })

  it('retains mid-turn rather than delegating the race to the provider', () => {
    expect(
      decideStructuredPointerDelivery({
        refusal: refusal(),
        session: { turnRunning: true, awaitingHuman: false }
      })
    ).toEqual({ deliver: false, retain: 'turn-unsettled' })
  })

  it('names the human prompt ahead of the turn, so the retain reason is the actionable one', () => {
    expect(
      decideStructuredPointerDelivery({
        refusal: refusal(),
        session: { turnRunning: true, awaitingHuman: true }
      })
    ).toEqual({ deliver: false, retain: 'awaiting-human' })
  })

  it('retains when the owner is not a settled native session', () => {
    expect(
      decideStructuredPointerDelivery({
        refusal: refusal({ handoffStage: 'preparing' }),
        session: IDLE
      })
    ).toEqual({ deliver: false, retain: 'owner-not-settled-native' })
  })
})

describe('dispatch outcome classification', () => {
  it('marks mail delivered only on an accepted dispatch', () => {
    expect(structuredDispatchDelivered('accepted')).toBe(true)
    expect(structuredDispatchDelivered('rejected')).toBe(false)
  })

  it('does not treat unknown as delivered, because a dead child settles unknown', () => {
    expect(structuredDispatchDelivered('unknown')).toBe(false)
  })

  it('names the retain reason for each non-accepted dispatch', () => {
    expect(retainReasonForDispatch('rejected')).toBe('dispatch-rejected')
    expect(retainReasonForDispatch('unknown')).toBe('dispatch-unknown')
  })
})

describe('retry pacing', () => {
  it('parks a nudge that may already be queued until the journal moves again', () => {
    expect(retainWaitsForJournalEdge('dispatch-unknown')).toBe(true)
    expect(retainWaitsForJournalEdge('turn-unsettled')).toBe(true)
    expect(retainWaitsForJournalEdge('awaiting-human')).toBe(true)
  })

  it('parks a detached session, because the re-attach edge is the only thing that will notice', () => {
    expect(retainWaitsForJournalEdge('session-not-attached')).toBe(true)
  })

  it('parks a rejected dispatch, because nothing else retries and no mail was consumed', () => {
    expect(retainWaitsForJournalEdge('dispatch-rejected')).toBe(true)
  })

  it('allows a plain retry only for an owner the resolver would not have named', () => {
    expect(retainWaitsForJournalEdge('owner-not-settled-native')).toBe(false)
  })
})
