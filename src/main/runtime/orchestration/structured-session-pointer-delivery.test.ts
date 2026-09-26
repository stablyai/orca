import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  decideStructuredSessionPointerDelivery,
  retainReasonForDispatch,
  structuredDispatchDelivered,
  structuredSessionGateFacts
} from './structured-session-pointer-delivery'

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

describe('decideStructuredSessionPointerDelivery', () => {
  it('delivers to an attached, idle session', () => {
    expect(decideStructuredSessionPointerDelivery({ session: IDLE })).toEqual({
      deliver: true
    })
  })

  it('retains when the session is not attached on this host', () => {
    expect(decideStructuredSessionPointerDelivery({ session: null })).toEqual({
      deliver: false,
      retain: 'session-not-attached'
    })
  })

  it('retains mid-turn rather than delegating the race to the provider', () => {
    expect(
      decideStructuredSessionPointerDelivery({
        session: { turnRunning: true, awaitingHuman: false }
      })
    ).toEqual({ deliver: false, retain: 'turn-unsettled' })
  })

  it('names the human prompt ahead of the turn, so the retain reason is the actionable one', () => {
    expect(
      decideStructuredSessionPointerDelivery({
        session: { turnRunning: true, awaitingHuman: true }
      })
    ).toEqual({ deliver: false, retain: 'awaiting-human' })
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
