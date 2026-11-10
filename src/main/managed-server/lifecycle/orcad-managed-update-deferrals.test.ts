import { afterEach, describe, expect, it } from 'vitest'
import {
  clearManagedOrcadUpdateDeferral,
  currentManagedOrcadUpdateDeferral,
  recordManagedOrcadUpdateDeferral,
  type OrcadIncumbent
} from './orcad-managed-update-deferrals'

const ACTIVE = '0.1.0+fb47a73e01d4'
const CANDIDATE = '0.1.0+9150d77ce015'
const ACTIVATED_AT = '2026-11-01T10:00:00.000Z'

const NONE: OrcadIncumbent = { active: null, activatedAt: null }
const RUNNING: OrcadIncumbent = { active: ACTIVE, activatedAt: ACTIVATED_AT }

function defer(incumbent: OrcadIncumbent, candidateVersion = CANDIDATE): void {
  recordManagedOrcadUpdateDeferral(
    'env-1',
    {
      outcome: 'deferred',
      candidateVersion,
      code: 'orcad_activation_fence_busy',
      reason: 'Another update holds this host.',
      forceable: false
    },
    incumbent
  )
}

afterEach(() => clearManagedOrcadUpdateDeferral('env-1'))

describe('a recorded update deferral', () => {
  it.each([
    // #38400: same release, different content hash; the versions cannot be ordered.
    [
      'another build of the same release',
      RUNNING,
      { active: '0.1.0+aaaaaaaaaaaa', activatedAt: '2026-11-02T10:00:00.000Z' }
    ],
    ['a first build', NONE, RUNNING],
    // Moved away and back between two reads: the same version, a newer activation.
    [
      'the same build activated again',
      RUNNING,
      { ...RUNNING, activatedAt: '2026-11-03T10:00:00.000Z' }
    ]
  ])('is dropped once the host moves to %s', (_label, atDeferral, movedTo) => {
    defer(atDeferral)
    expect(currentManagedOrcadUpdateDeferral('env-1', movedTo)).toBeNull()
    expect(currentManagedOrcadUpdateDeferral('env-1', atDeferral)).toBeNull()
  })

  it('is dropped when its candidate is the build the host already runs', () => {
    // An Update of the running build, refused while another desktop held the fence.
    defer(RUNNING, ACTIVE)
    expect(currentManagedOrcadUpdateDeferral('env-1', RUNNING)).toBeNull()
  })
})
