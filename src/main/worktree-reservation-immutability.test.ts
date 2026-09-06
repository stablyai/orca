import { describe, expect, it } from 'vitest'
import { buildResourceReservationBinding } from '../shared/resource-reservation-binding'
import { stripOrcaProvenanceMetaUpdates } from './worktree-removal-safety'

const BINDING = buildResourceReservationBinding(
  {
    key: 'key-1',
    reservationId: 'res-1',
    sessionId: 'session-1',
    resourceKind: 'worktree',
    ownershipGeneration: 1
  },
  { boundAt: 10 }
)

describe('worktree reservation immutability', () => {
  it('drops a reservation from a metadata update so worktree.set cannot rewrite the binding', () => {
    expect(stripOrcaProvenanceMetaUpdates({ comment: 'keep me', reservation: BINDING })).toEqual({
      comment: 'keep me'
    })
  })

  it('drops a reservation even when it is the only field offered', () => {
    expect(stripOrcaProvenanceMetaUpdates({ reservation: BINDING })).toEqual({})
  })
})
