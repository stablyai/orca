import { afterEach, describe, expect, it } from 'vitest'
import {
  clearManagedOrcadUpdateDeferral,
  currentManagedOrcadUpdateDeferral,
  recordManagedOrcadUpdateDeferral
} from './orcad-managed-update-deferrals'

const ACTIVE = '0.1.0+fb47a73e01d4'
const CANDIDATE = '0.1.0+9150d77ce015'

function defer(activeAtDeferral: string | null): void {
  recordManagedOrcadUpdateDeferral(
    'env-1',
    {
      outcome: 'deferred',
      candidateVersion: CANDIDATE,
      code: 'orcad_activation_fence_busy',
      reason: 'Another update holds this host.',
      forceable: false
    },
    activeAtDeferral
  )
}

afterEach(() => clearManagedOrcadUpdateDeferral('env-1'))

describe('a recorded update deferral', () => {
  it.each([null, ACTIVE])("stays while the host's active version is still %s", (active) => {
    defer(active)
    expect(currentManagedOrcadUpdateDeferral('env-1', active)).toEqual({
      outcome: 'deferred',
      candidateVersion: CANDIDATE,
      code: 'orcad_activation_fence_busy',
      reason: 'Another update holds this host.',
      forceable: false,
      deferredAt: expect.any(String)
    })
  })

  it.each([
    // #38400: same release, different content hash; the versions cannot be ordered.
    ['another build of the same release', ACTIVE, '0.1.0+aaaaaaaaaaaa'],
    ['a first build', null, ACTIVE]
  ])('is dropped once the host moves to %s', (_label, activeAtDeferral, movedTo) => {
    defer(activeAtDeferral)
    expect(currentManagedOrcadUpdateDeferral('env-1', movedTo)).toBeNull()
    expect(currentManagedOrcadUpdateDeferral('env-1', activeAtDeferral)).toBeNull()
  })
})
