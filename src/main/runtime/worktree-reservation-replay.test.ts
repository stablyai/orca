import { describe, expect, it } from 'vitest'
import { buildResourceReservationBinding } from '../../shared/resource-reservation-binding'
import type { ResourceReservationRequest } from '../../shared/resource-reservation-binding'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { findWorktreeReservation } from './worktree-reservation-replay'

const REQUEST: ResourceReservationRequest = {
  key: 'key-1',
  reservationId: 'res-1',
  sessionId: 'session-1',
  resourceKind: 'worktree',
  ownershipGeneration: 2
}

function meta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: 'wt',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('worktree reservation replay', () => {
  it('reports an unused key as unbound so the create proceeds', () => {
    expect(findWorktreeReservation({ 'repo::/a': meta() }, REQUEST)).toEqual({
      outcome: 'unbound'
    })
  })

  it('replays the same workspace for a retry with an identical binding', () => {
    const binding = buildResourceReservationBinding(REQUEST, { boundAt: 5 })

    const lookup = findWorktreeReservation(
      {
        'repo::/a': meta(),
        'repo::/b': meta({ reservation: binding, hostId: 'local', instanceId: 'instance-1' })
      },
      REQUEST
    )

    expect(lookup).toEqual({
      outcome: 'replay',
      worktreeId: 'repo::/b',
      hostId: 'local',
      instanceId: 'instance-1',
      binding
    })
  })

  it('refuses a reused key whose ownership generation moved on', () => {
    const binding = buildResourceReservationBinding(REQUEST, { boundAt: 5 })

    const lookup = findWorktreeReservation(
      { 'repo::/b': meta({ reservation: binding }) },
      {
        ...REQUEST,
        ownershipGeneration: 3
      }
    )

    expect(lookup.outcome).toBe('conflict')
    expect(lookup).toMatchObject({ worktreeId: 'repo::/b' })
  })

  it('does not replay a different key that happens to share a reservation id', () => {
    const binding = buildResourceReservationBinding(REQUEST, { boundAt: 5 })

    expect(
      findWorktreeReservation(
        { 'repo::/b': meta({ reservation: binding }) },
        {
          ...REQUEST,
          key: 'key-2'
        }
      )
    ).toEqual({ outcome: 'unbound' })
  })

  it('tolerates an empty or absent metadata map', () => {
    expect(findWorktreeReservation(undefined, REQUEST)).toEqual({ outcome: 'unbound' })
  })
})
