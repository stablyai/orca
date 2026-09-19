import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { IPtyProvider } from '../../../providers/types'
import { fenceOutgoingSourcePtyRoutes } from './outgoing-source-route-refusal'
import { getProviderForPty, registerSshPtyProvider, unregisterSshPtyProvider } from './registry'
import { ptyOwnership, setPtyOwnership, restorePtyIncarnation } from './ownership-state'
import { bindDelegatedPtyProviderRoute } from './delegated-provider-routes'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'

function fixture() {
  const target = randomUUID()
  const identity = {
    bridgeId: randomUUID(),
    terminalId: randomUUID(),
    incarnationId: 'incarnation',
    ownerLease: 'lease',
    sourceOwnerGeneration: 1,
    destinationRuntimeId: 'destination'
  }
  return {
    target,
    identity,
    id: toAppSshPtyId(target, identity.terminalId),
    digest: 'a'.repeat(64)
  }
}

it('blocks source fallback across provider replacement without affecting sibling or destination', () => {
  const f = fixture()
  const source = {} as IPtyProvider
  const replacement = {} as IPtyProvider
  const destination = {} as IPtyProvider
  registerSshPtyProvider(f.target, source)
  const release = bindDelegatedPtyProviderRoute(
    f.identity,
    { generation: 1, claimId: 'claim' },
    destination
  )
  try {
    ptyOwnership.set(f.id, f.target)
    fenceOutgoingSourcePtyRoutes(f.target, [f.identity], f.digest)
    expect(() => setPtyOwnership(f.id, f.target)).toThrow('source_control_released')
    expect(() => restorePtyIncarnation(f.id, 'replacement')).toThrow('source_control_released')
    expect(() => getProviderForPty(f.id)).toThrow('source_control_released')
    ptyOwnership.delete(f.id)
    registerSshPtyProvider(f.target, replacement)
    expect(() => getProviderForPty(f.id)).toThrow('source_control_released')
    expect(getProviderForPty(toAppSshPtyId(f.target, 'sibling'))).toBe(replacement)
    expect(getProviderForPty(f.identity.terminalId)).toBe(destination)
    expect(() => fenceOutgoingSourcePtyRoutes(f.target, [f.identity], f.digest)).not.toThrow()
  } finally {
    ptyOwnership.delete(f.id)
    unregisterSshPtyProvider(f.target)
    release()
  }
})

it('validates a whole cohort before publishing any new refusal', () => {
  const f = fixture()
  const sibling = { ...f.identity, terminalId: randomUUID(), bridgeId: randomUUID() }
  const provider = {} as IPtyProvider
  registerSshPtyProvider(f.target, provider)
  try {
    fenceOutgoingSourcePtyRoutes(f.target, [f.identity], f.digest)
    expect(() =>
      fenceOutgoingSourcePtyRoutes(
        f.target,
        [sibling, { ...f.identity, ownerLease: 'other' }],
        f.digest
      )
    ).toThrow('identity_conflict')
    expect(getProviderForPty(toAppSshPtyId(f.target, sibling.terminalId))).toBe(provider)
    expect(() => fenceOutgoingSourcePtyRoutes(f.target, [f.identity], 'b'.repeat(64))).toThrow(
      'record_conflict'
    )
  } finally {
    unregisterSshPtyProvider(f.target)
  }
})
