import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/types'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import {
  prepareOutgoingSshPtyRouteRetirement,
  restoreRetiredOutgoingSshPtyRoutes
} from './outgoing-source-route-retirement'
import { ptyOwnership, ptyIncarnationById } from './ownership-state'
import {
  registerSshPtyProvider,
  unregisterSshPtyProvider,
  sshProvidersByGeneration,
  getProviderForPty
} from './registry'

let generation = 810001
function fixture() {
  const targetId = randomUUID()
  const identities = [0, 1].map(() => ({
    bridgeId: randomUUID(),
    terminalId: randomUUID(),
    incarnationId: randomUUID(),
    ownerLease: 'owner',
    sourceOwnerGeneration: 1,
    destinationRuntimeId: 'destination'
  }))
  const ids = identities.map((identity) => toAppSshPtyId(targetId, identity.terminalId))
  const released = vi.fn((id: string) => ids.includes(id))
  const providerGeneration = generation++
  const provider = {
    providerGeneration,
    isOutgoingSourceControlReleased: released
  } as unknown as IPtyProvider
  registerSshPtyProvider(targetId, provider)
  ids.forEach((id, index) => {
    ptyOwnership.set(id, targetId)
    ptyIncarnationById.set(id, identities[index].incarnationId)
  })
  const options = {
    targetId,
    identities,
    expectedProvider: provider,
    providerGeneration,
    recordSha256: 'a'.repeat(64),
    assertAuthority: vi.fn()
  }
  return {
    options,
    ids,
    released,
    cleanup() {
      ids.forEach((id) => {
        ptyOwnership.delete(id)
        ptyIncarnationById.delete(id)
      })
      unregisterSshPtyProvider(targetId)
      sshProvidersByGeneration.delete(providerGeneration)
    }
  }
}

it('removes only the exact cohort and retains refusal on repeated retirement', () => {
  const f = fixture()
  try {
    const routes = prepareOutgoingSshPtyRouteRetirement(f.options)
    routes.retire()
    routes.retire()
    routes.assertRetired()
    for (const id of f.ids) {
      expect(ptyOwnership.has(id)).toBe(false)
      expect(ptyIncarnationById.has(id)).toBe(false)
      expect(() => getProviderForPty(id)).toThrow('source_control_released')
    }
    expect(getProviderForPty(toAppSshPtyId(f.options.targetId, 'sibling'))).toBe(
      f.options.expectedProvider
    )
  } finally {
    f.cleanup()
  }
})

it('restores absent routes without incumbent authority and refuses any reappeared route', () => {
  const f = fixture()
  try {
    expect(() => restoreRetiredOutgoingSshPtyRoutes(f.options)).toThrow('route_present')
    for (const id of f.ids) {
      ptyOwnership.delete(id)
      ptyIncarnationById.delete(id)
    }
    unregisterSshPtyProvider(f.options.targetId)
    const recovered = restoreRetiredOutgoingSshPtyRoutes(f.options)
    recovered.assertRetired()
    expect(() => getProviderForPty(f.ids[0])).toThrow('source_control_released')
    ptyOwnership.set(f.ids[1], 'replacement')
    expect(() => recovered.assertRetired()).toThrow('route_present')
    expect(ptyOwnership.get(f.ids[1])).toBe('replacement')
  } finally {
    f.cleanup()
  }
})

it.each(['provider', 'incarnation', 'ownership', 'release', 'authority'] as const)(
  'refuses stale %s without partial route removal',
  (mode) => {
    const f = fixture()
    try {
      const routes = prepareOutgoingSshPtyRouteRetirement(f.options)
      if (mode === 'provider') {
        registerSshPtyProvider(f.options.targetId, {} as IPtyProvider)
      }
      if (mode === 'incarnation') {
        ptyIncarnationById.set(f.ids[1], 'replacement')
      }
      if (mode === 'ownership') {
        ptyOwnership.set(f.ids[1], 'replacement')
      }
      if (mode === 'release') {
        f.released.mockReturnValue(false)
      }
      if (mode === 'authority') {
        f.options.assertAuthority.mockImplementation(() => {
          throw new Error('lost')
        })
      }
      expect(() => routes.retire()).toThrow()
      expect(ptyOwnership.has(f.ids[0])).toBe(true)
      expect(ptyIncarnationById.has(f.ids[0])).toBe(true)
      expect(ptyOwnership.has(f.ids[1])).toBe(true)
    } finally {
      f.cleanup()
    }
  }
)
