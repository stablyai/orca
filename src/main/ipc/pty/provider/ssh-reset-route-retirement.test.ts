import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/types'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { parseSshRelayResetIntent } from '../../../ssh/ssh-relay-reset-intent'
import {
  parseSshRelayResetRetirementSelection,
  parseSshRelayResetPreparationReceipt,
  sshRelayResetRecordDigest
} from '../../../ssh/ssh-relay-reset-retirement-record'
import { retireSshResetRoutes, SSH_RESET_CLIENT_INCARNATION } from './ssh-reset-route-retirement'
import { ptyOwnership, ptyIncarnationById, setPtyOwnership } from './ownership-state'
import { sshProviders, sshProvidersByGeneration } from './registry'
import { clearProviderPtyState } from './state-cleanup'
import { fenceOutgoingSourcePtyRoutes } from './outgoing-source-route-refusal'
import { captureSshResetRetirementSelection } from './ssh-reset-selection-capture'
import type { SshRemotePtyLease } from '../../../../shared/ssh-types'

vi.mock('./state-cleanup', () => ({ clearProviderPtyState: vi.fn() }))
const cleanups: (() => void)[] = []
let generation = 1000000
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  vi.mocked(clearProviderPtyState).mockReset()
})

function fixture(clientIncarnation = SSH_RESET_CLIENT_INCARNATION) {
  const targetId = randomUUID()
  const providerGeneration = ++generation
  const provider = { providerGeneration } as unknown as IPtyProvider
  const intent = parseSshRelayResetIntent({
    version: 1,
    targetId,
    targetGeneration: 1,
    targetRoutingDigest: 'a'.repeat(64),
    clientInstanceId: 'desktop',
    serverBuildId: 'build',
    endpoint: {
      relayDir: '/relay',
      runtimePath: '/relay/bun',
      runtimeKind: 'bun',
      sockPath: '/relay/socket',
      credentialFile: '/relay/cred',
      relayPlatform: 'linux-x64'
    },
    request: {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'daemon',
      ownerGeneration: 1,
      ownerLease: 'lease'
    }
  })
  const routes = ['a', 'b'].map((id) => ({
    appPtyId: toAppSshPtyId(targetId, id),
    incarnationId: randomUUID(),
    providerGeneration
  }))
  const selection = parseSshRelayResetRetirementSelection(
    {
      version: 1,
      intentSha256: sshRelayResetRecordDigest(intent),
      clientIncarnation,
      retiredAt: 100,
      leases: [],
      routes
    },
    intent
  )
  const receipt = parseSshRelayResetPreparationReceipt(
    {
      version: 1,
      intentSha256: selection.intentSha256,
      selectionSha256: sshRelayResetRecordDigest(selection),
      acknowledgment: {
        version: 1,
        operationId: 'reset',
        runtimeIncarnation: 'daemon',
        prepared: true
      }
    },
    intent,
    selection
  )
  sshProviders.set(targetId, provider)
  sshProvidersByGeneration.set(providerGeneration, provider)
  for (const route of routes) {
    ptyOwnership.set(route.appPtyId, targetId)
    ptyIncarnationById.set(route.appPtyId, route.incarnationId)
  }
  cleanups.push(() => {
    sshProviders.delete(targetId)
    sshProvidersByGeneration.delete(providerGeneration)
    for (const route of routes) {
      ptyOwnership.delete(route.appPtyId)
      ptyIncarnationById.delete(route.appPtyId)
    }
  })
  const options = {
    intent,
    selection,
    receipt,
    expectedProvider: provider,
    assertAuthority: vi.fn()
  }
  return { options, targetId, provider, providerGeneration, routes }
}

it('fences and removes the whole selection before ancillary callbacks can recreate routes', () => {
  const f = fixture()
  vi.mocked(clearProviderPtyState).mockImplementation(() => {
    for (const route of f.routes) {
      expect(ptyOwnership.has(route.appPtyId)).toBe(false)
      expect(ptyIncarnationById.has(route.appPtyId)).toBe(false)
      expect(() => setPtyOwnership(route.appPtyId, f.targetId)).toThrow('reset_route_retired')
    }
  })
  retireSshResetRoutes(f.options).assertRetired()
  expect(clearProviderPtyState).toHaveBeenCalledTimes(2)
  expect(sshProviders.get(f.targetId)).toBe(f.provider)
})

it.each(['owner', 'incarnation', 'provider', 'generation', 'desktop'])(
  'refuses changed %s without partial route removal',
  (change) => {
    const f = fixture(change === 'desktop' ? 'previous-desktop' : undefined)
    if (change === 'owner') {
      ptyOwnership.set(f.routes[1].appPtyId, 'other')
    }
    if (change === 'incarnation') {
      ptyIncarnationById.set(f.routes[1].appPtyId, 'replacement')
    }
    if (change === 'provider') {
      sshProviders.set(f.targetId, {} as IPtyProvider)
    }
    if (change === 'generation') {
      sshProvidersByGeneration.delete(f.providerGeneration)
    }
    expect(() => retireSshResetRoutes(f.options)).toThrow('selection_changed')
    expect(ptyOwnership.has(f.routes[0].appPtyId)).toBe(true)
    expect(clearProviderPtyState).not.toHaveBeenCalled()
  }
)

it('retries ancillary cleanup after failure without reopening admission', () => {
  const f = fixture()
  vi.mocked(clearProviderPtyState).mockImplementationOnce(() => {
    throw new Error('cleanup failed')
  })
  expect(() => retireSshResetRoutes(f.options)).toThrow('cleanup failed')
  for (const route of f.routes) {
    expect(() => setPtyOwnership(route.appPtyId, f.targetId)).toThrow('reset_route_retired')
  }
  retireSshResetRoutes(f.options).assertRetired()
  expect(clearProviderPtyState).toHaveBeenCalledTimes(3)
})

it('restores only absent-route fences after desktop restart without clearing new process state', () => {
  const f = fixture('previous-desktop')
  for (const route of f.routes) {
    ptyOwnership.delete(route.appPtyId)
    ptyIncarnationById.delete(route.appPtyId)
  }
  sshProviders.delete(f.targetId)
  retireSshResetRoutes(f.options).assertRetired()
  expect(clearProviderPtyState).not.toHaveBeenCalled()
})

it('refuses a conflicting ownership-transfer fence without partially removing reset routes', () => {
  const f = fixture()
  fenceOutgoingSourcePtyRoutes(
    f.targetId,
    [
      {
        terminalId: 'b',
        incarnationId: f.routes[1].incarnationId,
        bridgeId: randomUUID(),
        ownerLease: randomUUID(),
        sourceOwnerGeneration: 1,
        destinationRuntimeId: 'destination'
      }
    ],
    'b'.repeat(64)
  )
  expect(() => retireSshResetRoutes(f.options)).toThrow('refusal_conflict')
  expect(ptyOwnership.has(f.routes[0].appPtyId)).toBe(true)
  expect(ptyOwnership.has(f.routes[1].appPtyId)).toBe(true)
  expect(clearProviderPtyState).not.toHaveBeenCalled()
})

it('captures current routes and immutable leases without cleanup or fencing', () => {
  const f = fixture()
  const leases: SshRemotePtyLease[] = [
    { targetId: f.targetId, ptyId: 'a', state: 'attached', createdAt: 1, updatedAt: 2 }
  ]
  const capture = captureSshResetRetirementSelection({
    intent: f.options.intent,
    expectedProvider: f.provider,
    readLeases: () => leases,
    assertAuthority: f.options.assertAuthority,
    retiredAt: 100
  })
  expect(capture.selection.routes).toEqual(f.routes)
  expect(capture.selection.leases).toEqual(leases)
  capture.assertCurrent()
  expect(clearProviderPtyState).not.toHaveBeenCalled()
  setPtyOwnership(f.routes[0].appPtyId, f.targetId)
  leases[0].updatedAt = 3
  expect(capture.selection.leases[0].updatedAt).toBe(2)
  expect(() => capture.assertCurrent()).toThrow('selection_changed')
})

it.each(['new-route', 'removed-route', 'changed-incarnation', 'provider', 'orphan-incarnation'])(
  'refuses %s after selection capture',
  (change) => {
    const f = fixture()
    const capture = captureSshResetRetirementSelection({
      intent: f.options.intent,
      expectedProvider: f.provider,
      readLeases: () => [],
      assertAuthority: f.options.assertAuthority,
      retiredAt: 100
    })
    if (change === 'new-route') {
      const id = toAppSshPtyId(f.targetId, 'new')
      ptyOwnership.set(id, f.targetId)
      ptyIncarnationById.set(id, 'new-incarnation')
      cleanups.push(() => {
        ptyOwnership.delete(id)
        ptyIncarnationById.delete(id)
      })
    }
    if (change === 'removed-route') {
      ptyOwnership.delete(f.routes[0].appPtyId)
      ptyIncarnationById.delete(f.routes[0].appPtyId)
    }
    if (change === 'changed-incarnation') {
      ptyIncarnationById.set(f.routes[0].appPtyId, 'replacement')
    }
    if (change === 'provider') {
      sshProviders.delete(f.targetId)
    }
    if (change === 'orphan-incarnation') {
      ptyOwnership.delete(f.routes[0].appPtyId)
    }
    expect(() => capture.assertCurrent()).toThrow()
    expect(clearProviderPtyState).not.toHaveBeenCalled()
  }
)
