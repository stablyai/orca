import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionRideAlong } from './structured-agent-session-ride-along'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'

type RideAlongContext = Parameters<typeof structuredAgentSessionRideAlong>[0]

describe("a connector's message", () => {
  it('carries the turn context ahead of its words, as a person typing does', async () => {
    const launchUpdate = vi.fn(async () => null)
    const journal = {
      appendItem: async () => {},
      reads: { automationResultNotes: async () => ({ items: [], submissions: [] }) }
    }
    const ride = structuredAgentSessionRideAlong(
      {
        sessionId: 's1',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ride-along reads only these journal members for a send with no automation notes.
        journal: journal as unknown as RideAlongContext['journal'],
        turnContext: {
          plan: async () => ({ text: '[Memory and other chats]', given: () => {} }),
          launchUpdate
        }
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a connector delivery's submission as the host records it; the rest is unread here.
      { clientMessageId: 'c1', source: { kind: 'user' } } as AgentJournalSubmission,
      slackMessage()
    )
    await ride.claim(1, AGENT_JOURNAL_THREAD_SCOPE)

    expect(ride.outgoing(slackMessage()).blocks).toEqual([
      { type: 'text', text: '[Memory and other chats]\n\nwhich tier?' }
    ])
    expect(launchUpdate).not.toHaveBeenCalled()
  })
})

describe('a turn that vouches for the host instructions', () => {
  it('waits for their receipt, into the context it was planned against, before they count as given', async () => {
    const given = vi.fn()
    const instructions = vi.fn(async () => false)
    let record = agentSessionRecordFixture()
    const ride = structuredAgentSessionRideAlong(
      {
        sessionId: 's1',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ride-along reads only these journal members for a send with no automation notes.
        journal: {
          appendItem: async () => {},
          reads: { automationResultNotes: async () => ({ items: [], submissions: [] }) }
        } as unknown as RideAlongContext['journal'],
        record: () => record,
        recordRanOptions: Object.assign(async () => {}, { instructions }),
        turnContext: {
          plan: async () => ({ text: '', instructionsKey: 'k1', given }),
          launchUpdate: async () => null
        }
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a person's send as the host records it; the rest is unread here.
      { clientMessageId: 'c1', source: { kind: 'user' } } as AgentJournalSubmission,
      slackMessage()
    )
    await ride.claim(7, AGENT_JOURNAL_THREAD_SCOPE)
    const planned = JSON.stringify(['claude:"provider-session-alpha-1"', null, null, null])
    record = {
      ...record,
      providerContextBoundary: { operationId: 'clear-1', afterFence: 7, clearedAt: 5 }
    }

    expect(ride.outgoing(slackMessage()).blocks).toEqual([{ type: 'text', text: 'which tier?' }])
    await ride.taken(7)
    expect(instructions).toHaveBeenCalledWith('k1', planned)
    expect(given).toHaveBeenCalledWith({ instructionsRecorded: false })
  })
})

function slackMessage(): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'which tier?' }],
    origin: 'connector',
    asker: {
      source: 'slack',
      userId: 'U0SAM',
      role: 'member',
      place: { kind: 'public_channel', id: 'C9' }
    }
  }
}
