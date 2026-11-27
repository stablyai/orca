import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { chatTurnFor } from './external-conversation-turn-state'

const opener = (typedBy?: unknown) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a journal row with only the fields the reader reads.
  ({
    itemId: 'u1',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'post it' }],
      ...(typedBy ? { typedBy } : {})
    }
  }) as AgentJournalRenderItem

// A thread the owner's conversation follows, its turn opened in Orca.
const endedOwnerTurn = (typedBy?: unknown) =>
  chatTurnFor('local', 'owner')({ opener: opener(typedBy), stamps: [] }).turnFor

describe('whom an ended Orca-opened turn of the owner’s thread acts for', () => {
  it('is the owner’s for the owner’s own input', () => {
    expect(endedOwnerTurn({ by: 'host' })).toBe('owner')
    expect(endedOwnerTurn({ by: 'device', deviceId: 'd1', accountId: 'a1', own: true })).toBe(
      'owner'
    )
    expect(endedOwnerTurn({ by: 'agent' })).toBe('owner')
    expect(endedOwnerTurn()).toBe('owner')
  })

  it('is someone else’s when a device Orca can’t place as the owner opened it', () => {
    expect(endedOwnerTurn({ by: 'device', deviceId: 'd2', accountId: 'a2', own: false })).toBe(
      'someone_else'
    )
    expect(endedOwnerTurn({ by: 'device', deviceId: 'd3', accountId: 'a3' })).toBe('someone_else')
    expect(endedOwnerTurn({ by: 'device', deviceId: 'd4' })).toBe('someone_else')
    expect(endedOwnerTurn({ by: 'agent', deviceId: 'd5' })).toBe('someone_else')
    // Or steered into it, as the ended turn's reader found.
    expect(
      chatTurnFor(
        'local',
        'owner'
      )({
        opener: opener({ by: 'host' }),
        stamps: [],
        typedByAnother: true
      }).turnFor
    ).toBe('someone_else')
  })
})
