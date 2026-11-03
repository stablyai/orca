import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredSessionGateFacts } from './structured-session-pointer-delivery'

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

describe('structured session gate facts', () => {
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
