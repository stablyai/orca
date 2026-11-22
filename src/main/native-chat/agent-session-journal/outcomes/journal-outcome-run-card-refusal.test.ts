import { describe, expect, it } from 'vitest'
import { admitOutcomeFormat1 } from './journal-outcome-format-1'

// A bot run that couldn't start because its Hermes is too old (#46746), as the host saves its card.
const card = {
  itemId: 'item-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: {
    kind: 'automation-run-not-started',
    run: {
      runId: 'run-1',
      automation: {
        id: 'auto-1',
        name: 'Nightly triage',
        enabled: true,
        nextRunAt: 2,
        updatedAt: 1,
        dtstart: 1,
        rrule: 'FREQ=DAILY',
        workspaceId: null
      },
      trigger: 'scheduled',
      instructionsLength: 17
    },
    actsFor: [],
    error: 'Your Hermes CLI on this computer is 0.20.5. Chats need 0.23.0 or newer.',
    refusal: {
      code: 'structured_agent_session_unsupported',
      details: {
        reason: 'hostUnsupported',
        agentInstallation: { agent: 'hermes', installedVersion: '0.20.5', minimumVersion: '0.23.0' }
      }
    },
    text: 'Triage new issues',
    at: 1
  }
}

describe('admitOutcomeFormat1', () => {
  it('reads back a run card that keeps why its chat was refused', () => {
    const admitted = admitOutcomeFormat1({
      field: 'items',
      key: JSON.stringify(card.itemId),
      json: JSON.stringify(card),
      deleted: false
    })

    expect(admitted).toEqual({ entryKey: 'item-1', kept: card })
  })
})
