import { describe, expect, it, vi } from 'vitest'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapterOptions } from './relay-pty-ownership-transfer-adapter-contract'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { context, identity } from './relay-pty-ownership-transfer-delegation-test-fixture'
import {
  registerRelayPtySuccessorRetirement,
  supportsRelayPtySuccessorRetirement
} from './relay-pty-successor-retirement-registration'
import { PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD as METHOD } from '../shared/pty-ownership-transfer-successor-retirement'
import { parsePtyOwnershipBridgeCapabilities } from '../shared/pty-ownership-bridge-validation'

function fixture() {
  const begin = vi.fn(() => {
    throw new Error('unexpected ingress')
  })
  const prepare = vi.fn(() => {
    throw new Error('unexpected cancellation preparation')
  })
  const authorize = vi.fn(() => false)
  const options: RelayPtyOwnershipTransferAdapterOptions = {
    store: { loadAll: () => [], save: vi.fn(), remove: vi.fn() },
    enableSourceDeliveryRetirement: true,
    enableDestinationDelegationClaims: true,
    enableDestinationDelegationCommit: true,
    enableDestinationOutputRetention: true,
    resolveSource: () => null,
    authorizeRequest: () => false,
    setInputFenced: () => {},
    writeDestinationInput: () => {},
    publishDestinationOutput: () => {},
    successorRetirementDependencies: {
      handler: { beginOwnershipTransferCaptureIngress: begin },
      publication: {
        prepareCoveredOwnershipTransferRetirement: prepare,
        ownershipTransfer: {
          authorizesResumedTransferAtGeneration: authorize,
          inspectSuccessorRetainedDelivery: () => null
        }
      }
    }
  }
  const handlers = new Map<string, MethodHandler>()
  const register = () => {
    const state = newRelayPtyOwnershipTransferAdapterState({ options })
    registerRelayPtySuccessorRetirement(
      {
        onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler)
      } as unknown as RelayDispatcher,
      state
    )
    return handlers.get(METHOD)
  }
  return { options, register, begin, prepare, authorize }
}

function request() {
  return {
    version: 1,
    ...identity,
    successorGeneration: identity.sourceOwnerGeneration + 1,
    retirementRecordSha256: 'b'.repeat(64),
    recoveryOnly: false,
    savedBaseline: {
      version: 1,
      modelSha256: 'a'.repeat(64),
      boundary: {
        version: 1,
        identity,
        throughSeq: 0,
        delivery: {
          id: identity.terminalId,
          ptyIncarnation: identity.incarnationId,
          providerGeneration: 1,
          clientGeneration: 1,
          ownerGeneration: identity.sourceOwnerGeneration,
          deliveryToken: 'delivery',
          state: 'active',
          windowSu: 256,
          receivedEndSu: 0,
          sentEndSu: 0,
          creditedEndSu: 0,
          generationClosed: false,
          exitPublished: false
        }
      }
    }
  }
}

describe('successor retirement registration with mocked runtime refusal seams', () => {
  it('registers only with complete dependencies', () => {
    const f = fixture()
    expect(supportsRelayPtySuccessorRetirement(f.options)).toBe(true)
    expect(f.register()).toBeTypeOf('function')
    expect(f.begin).not.toHaveBeenCalled()
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it.each([
    'store',
    'enableSourceDeliveryRetirement',
    'enableDestinationDelegationClaims',
    'enableDestinationDelegationCommit',
    'enableDestinationOutputRetention',
    'successorRetirementDependencies'
  ] as const)('does not register without %s', (key) => {
    const f = fixture()
    delete f.options[key]
    expect(supportsRelayPtySuccessorRetirement(f.options)).toBe(false)
    expect(f.register()).toBeUndefined()
  })

  it.each([
    'beginOwnershipTransferCaptureIngress',
    'prepareCoveredOwnershipTransferRetirement',
    'authorizesResumedTransferAtGeneration',
    'inspectSuccessorRetainedDelivery'
  ] as const)('does not register without %s implementation', (key) => {
    const f = fixture()
    const deps = f.options.successorRetirementDependencies!
    for (const part of [deps.handler, deps.publication, deps.publication.ownershipTransfer]) {
      Reflect.deleteProperty(part, key)
    }
    expect(supportsRelayPtySuccessorRetirement(f.options)).toBe(false)
    expect(f.register()).toBeUndefined()
  })

  it('rechecks support when an already registered request arrives', async () => {
    const f = fixture()
    const handler = f.register()!
    Reflect.set(f.options, 'enableDestinationOutputRetention', false)
    await expect(handler(request(), context())).rejects.toThrow(
      'pty_successor_retirement_unavailable'
    )
    expect(f.begin).not.toHaveBeenCalled()
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it.each([
    { version: 2 },
    { successorGeneration: identity.sourceOwnerGeneration },
    { successorGeneration: 9.5 },
    { retirementRecordSha256: 'invalid' },
    { recoveryOnly: undefined },
    { savedBaseline: null }
  ])('rejects malformed requests before ingress: %j', async (patch) => {
    const f = fixture()
    await expect(f.register()!({ ...request(), ...patch }, context())).rejects.toThrow()
    expect(f.authorize).not.toHaveBeenCalled()
    expect(f.begin).not.toHaveBeenCalled()
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it.each(['fresh-owner', 'stale-context', 'unauthenticated'] as const)(
    'rejects %s before ingress or cancellation',
    async (mode) => {
      const f = fixture()
      const ctx = context()
      f.authorize.mockReturnValue(mode !== 'fresh-owner')
      if (mode === 'stale-context') {
        ctx.isStale = () => true
      }
      if (mode === 'unauthenticated') {
        ctx.sessionIdentity = undefined
      }
      await expect(f.register()!(request(), ctx)).rejects.toThrow(
        'pty_successor_retention_unavailable'
      )
      if (mode === 'fresh-owner') {
        expect(f.authorize).toHaveBeenCalledWith(identity.ownerLease, 9, ctx.clientId)
      } else {
        expect(f.authorize).not.toHaveBeenCalled()
      }
      expect(f.begin).not.toHaveBeenCalled()
      expect(f.prepare).not.toHaveBeenCalled()
    }
  )

  it('does not reinterpret recoveryOnly as authority for first retirement', async () => {
    const f = fixture()
    await expect(f.register()!({ ...request(), recoveryOnly: true }, context())).rejects.toThrow(
      'pty_source_retirement_recovery_journal_required'
    )
    expect(f.begin).not.toHaveBeenCalled()
    expect(f.prepare).not.toHaveBeenCalled()
  })
})

it('negotiates successor retirement independently of legacy drained retirement', () => {
  const supported = {
    protocolVersions: [1],
    maxReplayBytes: 64,
    maxInputIds: 32,
    inputDeduplication: true,
    rollback: true,
    liveTransfer: true,
    destinationOutput: true,
    destinationDelegationVersion: 1,
    sourceSuccessorRetirementVersion: 1
  }
  const parsed = parsePtyOwnershipBridgeCapabilities(supported)
  expect(parsed).toHaveProperty('sourceSuccessorRetirementVersion', 1)
  expect(parsed).not.toHaveProperty('sourceRetirementVersion')
  for (const version of [undefined, null, false, '1', 0, 2]) {
    const legacy = parsePtyOwnershipBridgeCapabilities({
      ...supported,
      sourceRetirementVersion: 1,
      sourceSuccessorRetirementVersion: version
    })
    expect(legacy).toHaveProperty('sourceRetirementVersion', 1)
    expect(legacy).not.toHaveProperty('sourceSuccessorRetirementVersion')
  }
  for (const patch of [{ liveTransfer: false }, { destinationDelegationVersion: undefined }]) {
    expect(parsePtyOwnershipBridgeCapabilities({ ...supported, ...patch })).not.toHaveProperty(
      'sourceSuccessorRetirementVersion'
    )
  }
})
