import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/types'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { prepareOutgoingSshPtyRouteRetirement } from './outgoing-source-route-retirement'
import { getProviderForPty, sshProviders, sshProvidersByGeneration } from './registry'
import { ptyOwnership, ptyIncarnationById, setPtyOwnership } from './ownership-state'

let nextGeneration = 900000
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function fixture() {
  const targetId = randomUUID()
  const providerGeneration = ++nextGeneration
  const identities = Array.from({ length: 3 }, () => ({
    terminalId: randomUUID(),
    incarnationId: randomUUID(),
    bridgeId: randomUUID(),
    ownerLease: randomUUID(),
    sourceOwnerGeneration: 1,
    destinationRuntimeId: 'destination'
  }))
  const ids = identities.map((identity) => toAppSshPtyId(targetId, identity.terminalId))
  const released = vi.fn(() => true)
  const dispose = vi.fn()
  const provider = {
    providerGeneration,
    isOutgoingSourceControlReleased: released,
    dispose
  } as unknown as IPtyProvider
  sshProviders.set(targetId, provider)
  sshProvidersByGeneration.set(providerGeneration, provider)
  ids.forEach((id, index) => {
    ptyOwnership.set(id, targetId)
    ptyIncarnationById.set(id, identities[index].incarnationId)
  })
  cleanups.push(() => {
    sshProviders.delete(targetId)
    sshProvidersByGeneration.delete(providerGeneration)
    ids.forEach((id) => {
      ptyOwnership.delete(id)
      ptyIncarnationById.delete(id)
    })
  })
  const assertAuthority = vi.fn()
  const options = {
    targetId,
    expectedProvider: provider,
    providerGeneration,
    identities: identities.slice(0, 2),
    recordSha256: 'a'.repeat(64),
    assertAuthority
  }
  const expectIntact = () => {
    ids.forEach((id, index) => {
      expect(ptyOwnership.get(id)).toBe(targetId)
      expect(ptyIncarnationById.get(id)).toBe(identities[index].incarnationId)
    })
  }
  return { ...options, options, provider, identities, ids, released, dispose, expectIntact }
}

it('retires only the exact cohort, preserves sibling and provider, and refuses fallback', () => {
  const f = fixture()
  const handle = prepareOutgoingSshPtyRouteRetirement(f.options)
  f.expectIntact()
  handle.assertCurrent()
  handle.retire()
  for (const id of f.ids.slice(0, 2)) {
    expect(ptyOwnership.has(id)).toBe(false)
    expect(ptyIncarnationById.has(id)).toBe(false)
    expect(() => getProviderForPty(id)).toThrow('source_control_released')
    expect(() => setPtyOwnership(id, f.targetId)).toThrow('source_control_released')
  }
  expect(ptyOwnership.get(f.ids[2])).toBe(f.targetId)
  expect(ptyIncarnationById.get(f.ids[2])).toBe(f.identities[2].incarnationId)
  expect(sshProviders.get(f.targetId)).toBe(f.provider)
  expect(sshProvidersByGeneration.get(f.providerGeneration)).toBe(f.provider)
  expect(f.dispose).not.toHaveBeenCalled()
  expect(f.released).toHaveBeenCalledWith(f.ids[0], f.identities[0])
  expect(() => handle.assertRetired()).not.toThrow()
  expect(() => handle.retire()).not.toThrow()
  expect(() => handle.assertCurrent()).toThrow('already_applied')
  sshProviders.set(f.targetId, {} as IPtyProvider)
  expect(() => getProviderForPty(f.ids[0])).toThrow('source_control_released')
})

it.each(['target', 'generation-index', 'provider-generation'] as const)(
  'rejects a mismatched %s before preparation or mutation',
  (mismatch) => {
    const f = fixture()
    if (mismatch === 'target') {
      sshProviders.set(f.targetId, {} as IPtyProvider)
    }
    if (mismatch === 'generation-index') {
      sshProvidersByGeneration.delete(f.providerGeneration)
    }
    if (mismatch === 'provider-generation') {
      Object.assign(f.provider, { providerGeneration: f.providerGeneration + 1 })
    }
    expect(() => prepareOutgoingSshPtyRouteRetirement(f.options)).toThrow('provider_changed')
    f.expectIntact()
  }
)

it('rejects provider replacement between preparation and retirement without removing any route', () => {
  const f = fixture()
  const handle = prepareOutgoingSshPtyRouteRetirement(f.options)
  sshProviders.set(f.targetId, {} as IPtyProvider)
  expect(() => handle.retire()).toThrow('provider_changed')
  f.expectIntact()
})

it.each(['incarnation', 'ownership'] as const)(
  'rejects changed %s in the final cohort member without partial removal',
  (mismatch) => {
    const f = fixture()
    const handle = prepareOutgoingSshPtyRouteRetirement(f.options)
    if (mismatch === 'incarnation') {
      ptyIncarnationById.set(f.ids[1], 'replacement')
    } else {
      ptyOwnership.set(f.ids[1], 'replacement')
    }
    expect(() => handle.retire()).toThrow('route_changed')
    expect(ptyOwnership.get(f.ids[0])).toBe(f.targetId)
    expect(ptyIncarnationById.get(f.ids[0])).toBe(f.identities[0].incarnationId)
    expect(ptyOwnership.has(f.ids[1])).toBe(true)
    expect(ptyIncarnationById.has(f.ids[1])).toBe(true)
    expect(() => setPtyOwnership(f.ids[0], f.targetId)).not.toThrow()
  }
)

it('requires release for every identity and rechecks it at retirement', () => {
  const f = fixture()
  f.released.mockReturnValueOnce(true).mockReturnValueOnce(false)
  expect(() => prepareOutgoingSshPtyRouteRetirement(f.options)).toThrow('release_required')
  f.expectIntact()
  const handle = prepareOutgoingSshPtyRouteRetirement(f.options)
  f.released.mockReturnValueOnce(true).mockReturnValueOnce(false)
  expect(() => handle.retire()).toThrow('release_required')
  f.expectIntact()
})

it('rejects providers without explicit release evidence', () => {
  const f = fixture()
  delete f.provider.isOutgoingSourceControlReleased
  expect(() => prepareOutgoingSshPtyRouteRetirement(f.options)).toThrow('release_required')
  f.expectIntact()
})

it('rechecks registry after release callbacks before removing anything', () => {
  const f = fixture()
  const handle = prepareOutgoingSshPtyRouteRetirement(f.options)
  f.released.mockImplementationOnce(() => {
    sshProvidersByGeneration.delete(f.providerGeneration)
    return true
  })
  expect(() => handle.retire()).toThrow('provider_changed')
  f.expectIntact()
})

it('rechecks authority for retirement and idempotent retry', () => {
  const f = fixture()
  const handle = prepareOutgoingSshPtyRouteRetirement(f.options)
  f.assertAuthority.mockImplementationOnce(() => {
    throw new Error('stale_authority')
  })
  expect(() => handle.retire()).toThrow('stale_authority')
  f.expectIntact()
  handle.retire()
  f.assertAuthority.mockImplementationOnce(() => {
    throw new Error('stale_authority')
  })
  expect(() => handle.retire()).toThrow('stale_authority')
})

it.each(['ownership', 'incarnation'] as const)('retry rejects resurrected %s', (map) => {
  const f = fixture()
  const handle = prepareOutgoingSshPtyRouteRetirement(f.options)
  handle.retire()
  if (map === 'ownership') {
    ptyOwnership.set(f.ids[0], f.targetId)
  } else {
    ptyIncarnationById.set(f.ids[0], f.identities[0].incarnationId)
  }
  expect(() => handle.retire()).toThrow('unconfirmed')
  expect(() => handle.assertRetired()).toThrow('unconfirmed')
})
