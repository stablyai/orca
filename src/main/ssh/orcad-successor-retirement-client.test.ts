import { beforeEach, expect, it, vi } from 'vitest'
import {
  retireOrcadSuccessorSourceDelivery,
  type OrcadSuccessorRetirementSession
} from './orcad-successor-retirement-client'
import { PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD } from '../../shared/pty-ownership-transfer-successor-retirement'

const gate = vi.hoisted(() => ({ enabled: true }))
vi.mock('../../shared/pty-ownership-transfer-release-gate', () => ({
  isPtyOwnershipTransferMutationEnabled: () => gate.enabled
}))
beforeEach(() => {
  gate.enabled = true
})

function fixture() {
  const identity = {
    terminalId: 'pty',
    incarnationId: 'incarnation',
    ownerLease: 'owner',
    sourceOwnerGeneration: 1,
    bridgeId: 'bridge',
    destinationRuntimeId: 'runtime'
  }
  const delivery = {
    id: 'pty',
    ptyIncarnation: 'incarnation',
    ownerGeneration: 1,
    providerGeneration: 1,
    clientGeneration: 1,
    deliveryToken: 'token',
    state: 'active',
    windowSu: 256,
    receivedEndSu: 20,
    sentEndSu: 20,
    creditedEndSu: 20,
    exitPublished: false,
    generationClosed: false
  }
  const request = {
    ...identity,
    version: 1,
    successorGeneration: 2,
    recoveryOnly: false,
    retirementRecordSha256: 'a'.repeat(64),
    savedBaseline: {
      version: 1,
      modelSha256: 'b'.repeat(64),
      boundary: { version: 1, identity, throughSeq: 5, delivery }
    }
  }
  const reply = {
    ...identity,
    version: 1,
    coveredSourceDeliveryRetirement: {
      phase: 'retired',
      retirementRecordSha256: request.retirementRecordSha256,
      modelSha256: request.savedBaseline.modelSha256,
      sourceOutputEndSeq: 12,
      receipt: {
        receiptId: 'receipt',
        bridgeId: 'bridge',
        acceptedSourceEndSeq: 5,
        committedAt: '2026-09-08T00:00:00.000Z'
      },
      delivery: { ...delivery, receivedEndSu: 320, sentEndSu: 276 }
    },
    sourceCancellation: { canceled: true, sentEndSu: 276, creditedEndSu: 20 }
  }
  const capabilities = {
    protocolVersions: [1],
    maxReplayBytes: 64,
    maxInputIds: 32,
    inputDeduplication: true,
    rollback: true,
    liveTransfer: true,
    destinationOutput: true,
    destinationDelegationVersion: 1,
    sourceRetirementVersion: 1,
    sourceSuccessorRetirementVersion: 1 as unknown
  }
  const rpc = vi.fn().mockResolvedValueOnce(capabilities).mockResolvedValueOnce(reply)
  const mux = { request: rpc, isDisposed: vi.fn(() => false) }
  let session: OrcadSuccessorRetirementSession | null = {
    targetId: 'host',
    mux,
    connection: {},
    transportGeneration: 1,
    resumed: true,
    owner: {
      mode: 'negotiated',
      clientInstanceId: 'client',
      clientGeneration: 3,
      ownerLease: 'owner',
      ownerGeneration: 2
    }
  }
  const controller = new AbortController()
  const assertAuthority = vi.fn()
  return {
    request,
    reply,
    capabilities,
    rpc,
    mux,
    controller,
    assertAuthority,
    get session() {
      return session!
    },
    setSession(value: OrcadSuccessorRetirementSession | null) {
      session = value
    },
    run: () =>
      retireOrcadSuccessorSourceDelivery({
        sourceSshTargetId: 'host',
        request,
        readSession: () => session,
        signal: controller.signal,
        assertAuthority
      })
  }
}

it('negotiates the distinct method and returns frozen actual unacknowledged counters', async () => {
  const f = fixture()
  const result = await f.run()
  expect(result).toEqual(f.reply)
  expect(result.coveredSourceDeliveryRetirement.delivery.creditedEndSu).toBe(20)
  expect(Object.isFrozen(result.coveredSourceDeliveryRetirement.delivery)).toBe(true)
  expect(f.rpc.mock.calls.map(([method]) => method)).toEqual([
    'pty.getOwnershipBridgeCapabilities',
    PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD
  ])
  expect(f.rpc.mock.calls[1][2]).toEqual({ signal: f.controller.signal, timeoutMs: 10_000 })
})

it.each([undefined, null, false, '1', 0, 2])(
  'never falls back for capability %s',
  async (version) => {
    const f = fixture()
    f.capabilities.sourceSuccessorRetirementVersion = version
    await expect(f.run()).rejects.toThrow('negotiation_required')
    expect(f.rpc).toHaveBeenCalledTimes(1)
  }
)

it.each(['resumed', 'lease', 'generation', 'absent', 'gate'])(
  'refuses invalid initial %s',
  async (kind) => {
    const f = fixture()
    if (kind === 'resumed') {
      f.setSession({ ...f.session, resumed: false })
    }
    if (kind === 'lease') {
      f.session.owner.ownerLease = 'other'
    }
    if (kind === 'generation') {
      f.session.owner.ownerGeneration = 3
    }
    if (kind === 'absent') {
      f.setSession(null)
    }
    if (kind === 'gate') {
      gate.enabled = false
    }
    await expect(f.run()).rejects.toThrow('orcad_successor_retirement_session_')
    expect(f.rpc).not.toHaveBeenCalled()
  }
)

for (const stage of [1, 2]) {
  it.each([
    'mux',
    'connection',
    'transport',
    'client',
    'clientGeneration',
    'lease',
    'ownerGeneration',
    'resumed',
    'disposed',
    'target',
    'absent',
    'abort',
    'authority',
    'gate'
  ])(`refuses changed %s after await ${stage}`, async (kind) => {
    const f = fixture()
    f.rpc.mockReset().mockImplementation(async () => {
      if (f.rpc.mock.calls.length === stage) {
        if (kind === 'mux') {
          f.setSession({ ...f.session, mux: { ...f.mux } })
        }
        if (kind === 'connection') {
          f.setSession({ ...f.session, connection: {} })
        }
        if (kind === 'transport') {
          f.setSession({ ...f.session, transportGeneration: 2 })
        }
        if (kind === 'client') {
          f.session.owner.clientInstanceId = 'replacement'
        }
        if (kind === 'clientGeneration') {
          f.session.owner.clientGeneration++
        }
        if (kind === 'lease') {
          f.session.owner.ownerLease = 'replacement'
        }
        if (kind === 'ownerGeneration') {
          f.session.owner.ownerGeneration++
        }
        if (kind === 'resumed') {
          f.setSession({ ...f.session, resumed: false })
        }
        if (kind === 'disposed') {
          f.mux.isDisposed.mockReturnValue(true)
        }
        if (kind === 'target') {
          f.setSession({ ...f.session, targetId: 'other' })
        }
        if (kind === 'absent') {
          f.setSession(null)
        }
        if (kind === 'abort') {
          f.controller.abort(new Error('aborted'))
        }
        if (kind === 'authority') {
          f.assertAuthority.mockImplementation(() => {
            throw new Error('authority_lost')
          })
        }
        if (kind === 'gate') {
          gate.enabled = false
        }
      }
      return f.rpc.mock.calls.length === 1 ? f.capabilities : f.reply
    })
    await expect(f.run()).rejects.toThrow()
    expect(f.rpc).toHaveBeenCalledTimes(stage)
  })
}

it('snapshots the request before capability negotiation yields', async () => {
  const f = fixture()
  const expected = structuredClone(f.request)
  f.rpc.mockReset().mockImplementation(async (method, request) => {
    if (method === 'pty.getOwnershipBridgeCapabilities') {
      f.request.ownerLease = 'tampered'
      f.request.savedBaseline.boundary.delivery.deliveryToken = 'tampered'
      return f.capabilities
    }
    expect(request).toEqual(expected)
    expect(Object.isFrozen(request.savedBaseline.boundary.delivery)).toBe(true)
    return f.reply
  })
  await expect(f.run()).resolves.toEqual(f.reply)
})

it('rejects a reply claiming synthetic acknowledgement', async () => {
  const f = fixture()
  f.reply.sourceCancellation.creditedEndSu = 276
  await expect(f.run()).rejects.toThrow('response_mismatch')
})
