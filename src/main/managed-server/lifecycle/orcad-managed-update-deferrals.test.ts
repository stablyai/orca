import { afterEach, describe, expect, it } from 'vitest'
import {
  clearManagedOrcadUpdateDeferral,
  currentManagedOrcadUpdateDeferral,
  recordManagedOrcadUpdateDeferral
} from './orcad-managed-update-deferrals'

function defer(candidateVersion: string, activeAtDeferral: string | null = '0.1.0+fb47a73e01d4'): void {
  recordManagedOrcadUpdateDeferral(
    'env-1',
    {
      outcome: 'deferred',
      candidateVersion,
      code: 'orcad_activation_fence_busy',
      reason: 'Another update holds this host.',
      forceable: false
    },
    activeAtDeferral
  )
}

afterEach(() => clearManagedOrcadUpdateDeferral('env-1'))

describe('a recorded update deferral', () => {
  it('is dropped once another desktop activated its candidate', () => {
    defer('0.1.0+9150d77ce015')
    expect(currentManagedOrcadUpdateDeferral('env-1', '0.1.0+9150d77ce015')).toBeNull()
    expect(currentManagedOrcadUpdateDeferral('env-1', '0.1.0+fb47a73e01d4')).toBeNull()
  })

  it('is dropped once the host runs a newer release', () => {
    defer('0.1.0+9150d77ce015')
    expect(currentManagedOrcadUpdateDeferral('env-1', '0.2.0+aaaaaaaaaaaa')).toBeNull()
  })

  it("stays while the host's active version has not moved", () => {
    defer('0.1.0+9150d77ce015')
    expect(currentManagedOrcadUpdateDeferral('env-1', '0.1.0+fb47a73e01d4')).toMatchObject({
      candidateVersion: '0.1.0+9150d77ce015'
    })
  })

  it('is dropped when the host moves to another build of the same release (#38400)', () => {
    // Same semver, different content hash: the version strings cannot be ordered, but the host
    // has moved since the deferral was recorded, so the cached deferral describes nothing current.
    defer('0.1.0+9150d77ce015', '0.1.0+fb47a73e01d4')
    expect(currentManagedOrcadUpdateDeferral('env-1', '0.1.0+aaaaaaaaaaaa')).toBeNull()
  })

  it('is dropped when a previously empty host gains an active version', () => {
    defer('0.1.0+9150d77ce015', null)
    expect(currentManagedOrcadUpdateDeferral('env-1', '0.1.0+fb47a73e01d4')).toBeNull()
  })
})
