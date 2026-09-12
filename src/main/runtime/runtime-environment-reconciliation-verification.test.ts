import { beforeEach, expect, it, vi } from 'vitest'
import { createEnvironmentFromPairingOffer } from '../../shared/runtime-environments'
import { RUNTIME_PROTOCOL_VERSION } from '../../shared/protocol-version'
import { verifyRuntimeEnvironmentReconciliation } from './runtime-environment-reconciliation-verification'

const { send, resolve } = vi.hoisted(() => ({ send: vi.fn(), resolve: vi.fn() }))
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: send }))
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: resolve }))

function environment(id: string) {
  return createEnvironmentFromPairingOffer({
    id,
    name: id,
    now: 1,
    runtimeId: 'host',
    offer: {
      v: 2,
      endpoint: `wss://${id}.example/runtime`,
      publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
      deviceToken: `token-${id}`,
      pairedDeviceId: `device-${id}`
    }
  })
}
function status(device: string, runtimeId = 'host') {
  return {
    id: 'status',
    ok: true,
    result: {
      runtimeId,
      pairedDeviceId: device,
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      deviceScope: 'runtime'
    },
    _meta: { runtimeId }
  }
}
let registrations: ReturnType<typeof environment>[]
beforeEach(() => {
  vi.resetAllMocks()
  registrations = [environment('left'), environment('right')]
  resolve.mockImplementation((_path, selector) =>
    registrations.find((entry) => entry.id === selector)
  )
  send.mockImplementation(async (pairing) => status(pairing.pairedDeviceId))
})
const args = { selectors: ['left', 'right'] as const }

it('authenticates both distinct grants without changing registrations or credential identity', async () => {
  const before = structuredClone(registrations)
  const result = await verifyRuntimeEnvironmentReconciliation('/profile', args)
  expect(result).toEqual({ runtimeId: 'host', registrations: before })
  expect(registrations).toEqual(before)
  expect(send.mock.calls.map((call) => call[0].deviceToken)).toEqual(['token-left', 'token-right'])
  expect(send.mock.calls.every((call) => call[1] === 'status.get')).toBe(true)
  expect(resolve).toHaveBeenCalledTimes(4)
})

it('requires live proof even when both cached runtime IDs agree', async () => {
  send.mockRejectedValueOnce(new Error('source unavailable'))
  await expect(verifyRuntimeEnvironmentReconciliation('/profile', args)).rejects.toThrow(
    'source unavailable'
  )
})

it.each(['key', 'runtime', 'same-registration'])(
  'rejects %s conflict before contact',
  async (conflict) => {
    if (conflict === 'key') {
      registrations[1].endpoints[0].publicKeyB64 = Buffer.alloc(32, 2).toString('base64')
    } else if (conflict === 'runtime') {
      registrations[1].runtimeId = 'other-host'
    }
    await expect(
      verifyRuntimeEnvironmentReconciliation('/profile', {
        selectors: conflict === 'same-registration' ? ['left', 'left'] : args.selectors
      })
    ).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  }
)

it('rejects different authenticated identities even with matching keys and unknown saved IDs', async () => {
  registrations.forEach((entry) => {
    entry.runtimeId = null
  })
  send
    .mockResolvedValueOnce(status('device-left'))
    .mockResolvedValueOnce(status('device-right', 'other-host'))
  await expect(verifyRuntimeEnvironmentReconciliation('/profile', args)).rejects.toThrow(
    'different hosts'
  )
})

it('rejects pairing replacement while requests are in flight', async () => {
  send.mockImplementationOnce(async (pairing) => {
    registrations[0] = { ...registrations[0], pairingRevision: 2 }
    return status(pairing.pairedDeviceId)
  })
  await expect(verifyRuntimeEnvironmentReconciliation('/profile', args)).rejects.toThrow(
    'changed during'
  )
})

it('rejects changed lifecycle ownership while requests are in flight', async () => {
  send.mockImplementationOnce(async (pairing) => {
    registrations[0] = { ...registrations[0], source: 'ephemeral-vm' }
    return status(pairing.pairedDeviceId)
  })
  await expect(verifyRuntimeEnvironmentReconciliation('/profile', args)).rejects.toThrow(
    'changed during'
  )
})

it('rejects cancellation before contact and after otherwise valid replies', async () => {
  await expect(
    verifyRuntimeEnvironmentReconciliation('/profile', {
      ...args,
      signal: AbortSignal.abort()
    })
  ).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
  const controller = new AbortController()
  send.mockImplementation(async (pairing) => {
    controller.abort()
    return status(pairing.pairedDeviceId)
  })
  await expect(
    verifyRuntimeEnvironmentReconciliation('/profile', {
      ...args,
      signal: controller.signal
    })
  ).rejects.toThrow()
})

it.each(['grant', 'envelope', 'scope'])(
  'rejects incorrect %s in authenticated status',
  async (field) => {
    const response = status('device-left')
    if (field === 'grant') {
      response.result.pairedDeviceId = 'wrong-grant'
    }
    if (field === 'envelope') {
      response._meta.runtimeId = 'wrong-host'
    }
    if (field === 'scope') {
      response.result.deviceScope = 'mobile'
    }
    send.mockResolvedValueOnce(response)
    await expect(verifyRuntimeEnvironmentReconciliation('/profile', args)).rejects.toThrow()
  }
)
