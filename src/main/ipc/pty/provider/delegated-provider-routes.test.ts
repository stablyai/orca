import { expect, it } from 'vitest'
import type { IPtyProvider } from '../../../providers/types'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { identity as base } from '../../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import {
  reserveDelegatedPtyProviderRoute,
  bindDelegatedPtyProviderRoute,
  retireDelegatedPtyProviderRoute,
  hasDelegatedPtyProviderRoute,
  delegatedPtyProviderRoutesRevision
} from './delegated-provider-routes'
import {
  getProviderForPty,
  registeredPtyProviders,
  getLocalPtyProvider,
  hasPtyProviderForInspection,
  tryGetProviderForAgentSessionOwner,
  tryGetProviderForPty
} from './registry'

it('retires active inventory without allowing stale native fallback or rebind', () => {
  const identity = { ...base, terminalId: 'delegated-retired' }
  const claim = { generation: 1, claimId: 'retired' }
  const provider = {} as IPtyProvider
  const release = bindDelegatedPtyProviderRoute(identity, claim, provider)
  const before = registeredPtyProviders()
  retireDelegatedPtyProviderRoute(identity, claim)
  expect(before[0].isCurrent?.()).toBe(false)
  expect(
    before
      .find((entry) => entry.delegatedIdentity?.terminalId === identity.terminalId)
      ?.isCurrent?.()
  ).toBe(false)
  expect(
    registeredPtyProviders().some(
      (entry) => entry.delegatedIdentity?.terminalId === identity.terminalId
    )
  ).toBe(false)
  expect(hasDelegatedPtyProviderRoute(identity.terminalId)).toBe(true)
  expect(() => getProviderForPty(identity.terminalId)).toThrow('exited')
  expect(tryGetProviderForPty(identity.terminalId)).toBeUndefined()
  expect(tryGetProviderForAgentSessionOwner(identity.terminalId)).toBeUndefined()
  expect(hasPtyProviderForInspection(identity.terminalId)).toBe(false)
  const revision = delegatedPtyProviderRoutesRevision()
  release()
  retireDelegatedPtyProviderRoute(identity, claim)
  expect(delegatedPtyProviderRoutesRevision()).toBe(revision)
  expect(() =>
    bindDelegatedPtyProviderRoute(identity, { generation: 2, claimId: 'new' }, provider)
  ).toThrow('exited')
})

it('reconstructs a retirement tombstone without connecting to a source', () => {
  const identity = { ...base, terminalId: 'delegated-retired-recovery' }
  retireDelegatedPtyProviderRoute(identity, { generation: 3, claimId: 'recovered' })
  expect(hasDelegatedPtyProviderRoute(identity.terminalId)).toBe(true)
  expect(() => getProviderForPty(identity.terminalId)).toThrow('exited')
})

it('rejects stale retirement evidence without changing the active route', () => {
  const identity = { ...base, terminalId: 'delegated-stale-retirement' }
  const provider = {} as IPtyProvider
  const claim = { generation: 2, claimId: 'current' }
  bindDelegatedPtyProviderRoute(identity, claim, provider)
  const revision = delegatedPtyProviderRoutesRevision()
  expect(() =>
    retireDelegatedPtyProviderRoute(identity, { generation: 1, claimId: 'old' })
  ).toThrow('claim_conflict')
  expect(() =>
    retireDelegatedPtyProviderRoute(identity, { generation: 2, claimId: 'other' })
  ).toThrow('claim_conflict')
  expect(() =>
    retireDelegatedPtyProviderRoute({ ...identity, incarnationId: 'other' }, claim)
  ).toThrow('identity_conflict')
  expect(getProviderForPty(identity.terminalId)).toBe(provider)
  expect(delegatedPtyProviderRoutesRevision()).toBe(revision)
})

it('snapshots disconnected routes and fences aggregate coverage when a route is added or rebound', () => {
  const identity = { ...base, terminalId: 'delegated-inventory-revision' }
  const nativeBefore = registeredPtyProviders()[0]
  reserveDelegatedPtyProviderRoute(identity)
  expect(nativeBefore.isCurrent?.()).toBe(false)
  const disconnected = registeredPtyProviders().find(
    (entry) => entry.delegatedIdentity?.terminalId === identity.terminalId
  )!
  expect(disconnected.provider).toBeUndefined()
  const provider = {} as IPtyProvider
  const release = bindDelegatedPtyProviderRoute(
    identity,
    { generation: 1, claimId: 'inventory' },
    provider
  )
  expect(disconnected.isCurrent?.()).toBe(false)
  const connected = registeredPtyProviders().find(
    (entry) => entry.delegatedIdentity?.terminalId === identity.terminalId
  )!
  expect(connected.provider).toBe(provider)
  expect(connected.isCurrent?.()).toBe(true)
  release()
  expect(connected.isCurrent?.()).toBe(false)
})

it('keeps reserved and disconnected delegated IDs off the local daemon', () => {
  const identity = { ...base, terminalId: 'delegated-reservation' }
  reserveDelegatedPtyProviderRoute(identity)
  expect(() => getProviderForPty(identity.terminalId)).toThrow('unverifiable')
  expect(tryGetProviderForPty(identity.terminalId)).toBeUndefined()
  expect(tryGetProviderForAgentSessionOwner(identity.terminalId)).toBeUndefined()
  expect(hasPtyProviderForInspection(identity.terminalId)).toBe(false)
  const provider = {} as IPtyProvider
  const claim = { generation: 1, claimId: 'first' }
  const disconnect = bindDelegatedPtyProviderRoute(identity, claim, provider)
  expect(getProviderForPty(identity.terminalId)).toBe(provider)
  expect(tryGetProviderForAgentSessionOwner(identity.terminalId)).toBe(provider)
  expect(hasPtyProviderForInspection(identity.terminalId)).toBe(true)
  disconnect()
  expect(() => getProviderForPty(identity.terminalId)).toThrow('unverifiable')
  expect(() => bindDelegatedPtyProviderRoute(identity, claim, provider)).toThrow('claim_conflict')
})

it('fences stale claims and stale cleanup after a replacement', () => {
  const identity = { ...base, terminalId: 'delegated-replacement' }
  const first = {} as IPtyProvider
  const second = {} as IPtyProvider
  const disconnect = bindDelegatedPtyProviderRoute(
    identity,
    { generation: 1, claimId: 'first' },
    first
  )
  bindDelegatedPtyProviderRoute(identity, { generation: 2, claimId: 'second' }, second)
  disconnect()
  expect(getProviderForPty(identity.terminalId)).toBe(second)
  expect(() =>
    bindDelegatedPtyProviderRoute(identity, { generation: 1, claimId: 'first' }, first)
  ).toThrow('claim_conflict')
  expect(() =>
    bindDelegatedPtyProviderRoute(identity, { generation: 2, claimId: 'other' }, second)
  ).toThrow('claim_conflict')
  expect(() =>
    bindDelegatedPtyProviderRoute(identity, { generation: 2, claimId: 'second' }, first)
  ).toThrow('claim_conflict')
})

it('rejects a conflicting incarnation and snapshots mutable identity input', () => {
  const identity = { ...base, terminalId: 'delegated-identity' }
  reserveDelegatedPtyProviderRoute(identity)
  identity.incarnationId = 'changed'
  expect(() => reserveDelegatedPtyProviderRoute(identity)).toThrow('identity_conflict')
})

it('preserves ordinary local routing for IDs outside delegated ownership', () => {
  expect(getProviderForPty('ordinary-local')).toBe(getLocalPtyProvider())
  expect(tryGetProviderForAgentSessionOwner('ordinary-local')).toBe(getLocalPtyProvider())
})

it('rejects SSH IDs without changing their existing transport ownership', () => {
  const id = toAppSshPtyId('missing-ssh', 'terminal')
  expect(() => reserveDelegatedPtyProviderRoute({ ...base, terminalId: id })).toThrow(
    'requires_host_local_id'
  )
  expect(() => getProviderForPty(id)).toThrow('No PTY provider for connection')
  expect(tryGetProviderForAgentSessionOwner(id)).toBeUndefined()
})

it('does not reserve a route when claim validation fails', () => {
  const identity = { ...base, terminalId: 'invalid-claim-no-route' }
  expect(() =>
    bindDelegatedPtyProviderRoute(
      identity,
      { generation: 0, claimId: 'invalid' },
      {} as IPtyProvider
    )
  ).toThrow()
  expect(getProviderForPty(identity.terminalId)).toBe(getLocalPtyProvider())
})
