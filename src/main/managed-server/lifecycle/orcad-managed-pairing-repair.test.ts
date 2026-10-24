import { describe, expect, it, vi } from 'vitest'
import {
  encodePairingOffer,
  PAIRING_OFFER_VERSION,
  type PairingOffer
} from '../../../shared/pairing'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import type { ServeReadiness } from '../../server/serve-readiness'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import {
  ManagedOrcadPairingRepairs,
  MAX_PAIRING_REPAIRS_PER_WINDOW,
  pairingRevisionOf,
  PAIRING_REPAIR_FAILURE_HOLD_MS,
  PAIRING_REPAIR_WINDOW_MS
} from './orcad-managed-pairing-repair'
import { OrcadManagedPairingRepairFailedError } from './orcad-managed-pairing-repair-failure'
import {
  OrcadManagedIdentityError,
  OrcadManagedPairingRejectedError
} from './orcad-managed-tunnel-identity'
import { buildWithPairingRepair } from './orcad-managed-tunnel-pairing-recovery'

const KEY = 'pinned-host-key'

function offer(deviceToken: string, publicKeyB64 = KEY): PairingOffer {
  return {
    v: PAIRING_OFFER_VERSION,
    endpoint: 'ws://127.0.0.1:46768',
    deviceToken,
    publicKeyB64,
    pairedDeviceId: `device-${deviceToken}`
  }
}

function environment(deviceToken: string, revision = 1): KnownRuntimeEnvironment {
  return {
    ...createEnvironmentFromPairingOffer({
      id: 'env-1',
      name: 'Box server',
      now: revision,
      offer: offer(deviceToken),
      connectionDependency: 'ssh-tunnel'
    }),
    orcadDeployment: {
      sshTargetId: 'box',
      sshTargetGeneration: 1,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

function readiness(published: PairingOffer | null): ServeReadiness {
  return {
    runtimeId: 'runtime-now',
    boundEndpoint: 'ws://127.0.0.1:6768',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: published
      ? {
          available: true,
          url: encodePairingOffer({ ...published, endpoint: 'ws://127.0.0.1:6768' }),
          endpoint: 'ws://127.0.0.1:6768',
          deviceId: published.pairedDeviceId!,
          webClientUrl: null,
          scope: 'runtime',
          qr: null
        }
      : { available: false, reason: 'disabled_by_operator', guidance: 'Restart with pairing.' }
  }
}

const REFUSED = 1

function setup(published: () => ServeReadiness | null) {
  let current = environment('refused-token', REFUSED)
  let now = 0
  const deps = {
    resolve: vi.fn(() => current),
    connect: vi.fn(async () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only handed to readReadiness, a double here.
      target: {} as SshTarget,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only handed to readReadiness, a double here.
      connection: {} as OrcadHostTransport
    })),
    readReadiness: vi.fn(async () => published()),
    refresh: vi.fn((_id: string, _code: string) => {
      const count = deps.refresh.mock.calls.length
      current = environment(`fresh-${count}`, REFUSED + count)
      return current
    }),
    repaired: vi.fn(),
    now: () => now
  }
  return {
    deps,
    repairs: new ManagedOrcadPairingRepairs(deps),
    refuseCurrent: () => pairingRevisionOf(current),
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('ManagedOrcadPairingRepairs', () => {
  it('keeps the offer the server publishes now and retires the refused transports once', async () => {
    const state = setup(() => readiness(offer('fresh-token')))
    const repaired = await state.repairs.repair('env-1', REFUSED)
    expect(state.deps.refresh).toHaveBeenCalledOnce()
    expect(state.deps.repaired).toHaveBeenCalledExactlyOnceWith('env-1')
    expect(pairingRevisionOf(repaired)).not.toBe(REFUSED)
  })

  it('runs one repair at a time for concurrent refusals', async () => {
    const state = setup(() => readiness(offer('fresh-token')))
    await Promise.all([
      state.repairs.repair('env-1', REFUSED),
      state.repairs.repair('env-1', REFUSED)
    ])
    expect(state.deps.readReadiness).toHaveBeenCalledOnce()
    expect(state.deps.repaired).toHaveBeenCalledOnce()
  })

  it('answers a late refusal of the old pairing with the stored one, without the host', async () => {
    const state = setup(() => readiness(offer('fresh-token')))
    const first = await state.repairs.repair('env-1', REFUSED)
    await expect(state.repairs.repair('env-1', REFUSED)).resolves.toEqual(first)
    expect(state.deps.readReadiness).toHaveBeenCalledOnce()
    expect(state.deps.repaired).toHaveBeenCalledOnce()
  })

  it('refuses an offer under another host key, so a foreign server stays foreign', async () => {
    const state = setup(() => readiness(offer('fresh-token', 'other-key')))
    await expect(state.repairs.repair('env-1', REFUSED)).rejects.toBeInstanceOf(
      OrcadManagedIdentityError
    )
    expect(state.deps.refresh).not.toHaveBeenCalled()
    expect(state.deps.repaired).not.toHaveBeenCalled()
  })

  it('says why when the server still offers the token it refused', async () => {
    const state = setup(() => readiness(offer('refused-token')))
    await expect(state.repairs.repair('env-1', REFUSED)).rejects.toThrow(
      /still offers the pairing it refused/
    )
    expect(state.deps.refresh).not.toHaveBeenCalled()
  })

  it.each([
    ['publishes no readiness', () => null, /hasn't published a pairing/],
    ['offers no pairing', () => readiness(null), /isn't offering a pairing/]
  ])('fails clearly when the server %s', async (_name, published, message) => {
    const state = setup(published)
    const failure = state.repairs.repair('env-1', REFUSED)
    await expect(failure).rejects.toBeInstanceOf(OrcadManagedPairingRepairFailedError)
    await expect(failure).rejects.toThrow(message)
  })

  it('reports a pairing the store would not keep as a failed repair', async () => {
    const state = setup(() => readiness(offer('fresh-token')))
    state.deps.refresh.mockImplementationOnce(() => {
      throw new Error('The managed pairing does not point at its SSH tunnel.')
    })
    await expect(state.repairs.repair('env-1', REFUSED)).rejects.toBeInstanceOf(
      OrcadManagedPairingRepairFailedError
    )
  })

  it('holds a failure briefly instead of re-reading the host for every reconnect', async () => {
    const state = setup(() => readiness(offer('refused-token')))
    await expect(state.repairs.repair('env-1', REFUSED)).rejects.toThrow()
    await expect(state.repairs.repair('env-1', REFUSED)).rejects.toThrow()
    expect(state.deps.readReadiness).toHaveBeenCalledOnce()
    state.advance(PAIRING_REPAIR_FAILURE_HOLD_MS)
    await expect(state.repairs.repair('env-1', REFUSED)).rejects.toThrow()
    expect(state.deps.readReadiness).toHaveBeenCalledTimes(2)
  })

  it('does not count or hold a lost SSH connection, which says nothing about the pairing', async () => {
    const state = setup(() => readiness(offer('fresh-token')))
    for (let i = 0; i <= MAX_PAIRING_REPAIRS_PER_WINDOW; i++) {
      state.deps.connect.mockRejectedValueOnce(new Error('ssh: connection reset'))
      await expect(state.repairs.repair('env-1', REFUSED)).rejects.toThrow('connection reset')
    }
    await expect(state.repairs.repair('env-1', REFUSED)).resolves.toBeDefined()
  })

  it('does not count an SSH read that dropped mid-way', async () => {
    const state = setup(() => readiness(offer('fresh-token')))
    for (let i = 0; i <= MAX_PAIRING_REPAIRS_PER_WINDOW; i++) {
      state.deps.readReadiness.mockRejectedValueOnce(new Error('ssh: channel closed'))
      await expect(state.repairs.repair('env-1', REFUSED)).rejects.toThrow('channel closed')
    }
    await expect(state.repairs.repair('env-1', REFUSED)).resolves.toBeDefined()
  })

  it.each(['stale-token', 'refused-token'])(
    'keeps a pairing an update stored while the host was being read (answer: %s)',
    async (answered) => {
      const state = setup(() => readiness(offer('fresh-token')))
      const updated = environment('updated-token', 7)
      state.deps.readReadiness.mockImplementationOnce(async () => {
        state.deps.resolve.mockReturnValue(updated)
        return readiness(offer(answered))
      })
      await expect(state.repairs.repair('env-1', REFUSED)).resolves.toBe(updated)
      expect(state.deps.refresh).not.toHaveBeenCalled()
      expect(state.deps.repaired).not.toHaveBeenCalled()
    }
  )

  it('caps attempts per window, failed ones included', async () => {
    let issued = 0
    const state = setup(() => readiness(offer(issued++ % 2 ? `issued-${issued}` : 'refused-token')))
    for (let i = 0; i < MAX_PAIRING_REPAIRS_PER_WINDOW; i++) {
      await state.repairs.repair('env-1', state.refuseCurrent()).catch(() => undefined)
      state.advance(PAIRING_REPAIR_FAILURE_HOLD_MS)
    }
    const capped = state.repairs.repair('env-1', state.refuseCurrent())
    await expect(capped).rejects.toBeInstanceOf(OrcadManagedPairingRepairFailedError)
    await expect(capped).rejects.toThrow(/tried 3 times/)
    state.advance(PAIRING_REPAIR_WINDOW_MS)
    state.deps.readReadiness.mockResolvedValueOnce(readiness(offer('late-token')))
    await expect(state.repairs.repair('env-1', state.refuseCurrent())).resolves.toBeDefined()
  })

  it('lets an explicit connect retry past both the held failure and the cap', async () => {
    const state = setup(() => readiness(offer('refused-token')))
    for (let i = 0; i < MAX_PAIRING_REPAIRS_PER_WINDOW; i++) {
      await state.repairs.repair('env-1', REFUSED).catch(() => undefined)
      state.advance(PAIRING_REPAIR_FAILURE_HOLD_MS)
    }
    await expect(state.repairs.repair('env-1', REFUSED)).rejects.toThrow(/tried 3 times/)
    state.repairs.forgetFailures('env-1')
    state.deps.readReadiness.mockResolvedValueOnce(readiness(offer('fixed-token')))
    await expect(state.repairs.repair('env-1', REFUSED)).resolves.toBeDefined()
  })

  it('keeps a connect that lands mid-repair from being undone by that repair', async () => {
    const state = setup(() => readiness(offer('refused-token')))
    for (let i = 0; i < MAX_PAIRING_REPAIRS_PER_WINDOW - 1; i++) {
      await state.repairs.repair('env-1', REFUSED).catch(() => undefined)
      state.advance(PAIRING_REPAIR_FAILURE_HOLD_MS)
    }
    let answer: (value: ServeReadiness) => void = () => {}
    state.deps.readReadiness.mockImplementationOnce(
      () => new Promise<ServeReadiness>((resolve) => (answer = resolve))
    )
    const inFlight = state.repairs.repair('env-1', REFUSED)
    await vi.waitFor(() => expect(state.deps.readReadiness).toHaveBeenCalledTimes(3))
    state.repairs.forgetFailures('env-1')
    answer(readiness(offer('refused-token')))
    await expect(inFlight).rejects.toThrow(/still offers/)
    // Explicit reset must discard both in-flight failures and their attempt counts.
    expect(state.repairs.standingFailure('env-1', REFUSED)).toBeNull()
    for (let i = 0; i < MAX_PAIRING_REPAIRS_PER_WINDOW; i++) {
      await expect(state.repairs.repair('env-1', REFUSED)).rejects.toThrow(/still offers/)
      state.advance(PAIRING_REPAIR_FAILURE_HOLD_MS)
    }
    expect(state.deps.readReadiness).toHaveBeenCalledTimes(3 + MAX_PAIRING_REPAIRS_PER_WINDOW)
  })
})

describe('buildWithPairingRepair', () => {
  function recovery() {
    const state = setup(() => readiness(offer('fresh-token')))
    return {
      state,
      recovery: {
        resolve: state.deps.resolve,
        repairs: state.repairs,
        ensure: vi.fn<(environment: KnownRuntimeEnvironment) => Promise<void>>()
      }
    }
  }
  const refusal = () => new OrcadManagedPairingRejectedError('rejected the pairing token')

  it('re-pairs once on a refusal from our own server, then forwards on the new pairing', async () => {
    const { state, recovery: deps } = recovery()
    const build = vi.fn().mockRejectedValueOnce(refusal())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(buildWithPairingRepair(deps, 'env-1', build)).resolves.toBe('repaired')
    warn.mockRestore()
    expect(state.deps.refresh).toHaveBeenCalledOnce()
    expect(deps.ensure.mock.calls[0]?.[0].endpoints[0]).toMatchObject({ deviceToken: 'fresh-1' })
  })

  it('never re-pairs on a foreign answer or lost contact', async () => {
    const { state, recovery: deps } = recovery()
    const foreign = new OrcadManagedIdentityError(6_768, '4001: Unauthorized')
    await expect(
      buildWithPairingRepair(deps, 'env-1', vi.fn().mockRejectedValue(foreign))
    ).rejects.toBe(foreign)
    expect(state.deps.readReadiness).not.toHaveBeenCalled()
  })

  it('builds at most the capped number of times however many refused opens ask', async () => {
    const state = setup(() => readiness(offer('refused-token')))
    const deps = { resolve: state.deps.resolve, repairs: state.repairs, ensure: vi.fn() }
    const build = vi.fn().mockRejectedValue(refusal())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let open = 0; open < 200; open++) {
      await expect(buildWithPairingRepair(deps, 'env-1', build)).rejects.toBeInstanceOf(
        OrcadManagedPairingRepairFailedError
      )
      state.advance(1_000)
    }
    warn.mockRestore()
    expect(build).toHaveBeenCalledTimes(MAX_PAIRING_REPAIRS_PER_WINDOW)
    expect(state.deps.readReadiness).toHaveBeenCalledTimes(MAX_PAIRING_REPAIRS_PER_WINDOW)
    await expect(buildWithPairingRepair(deps, 'env-1', build)).rejects.toThrow(/tried 3 times/)
    state.repairs.forgetFailures('env-1')
    await expect(buildWithPairingRepair(deps, 'env-1', build)).rejects.toThrow()
    expect(build).toHaveBeenCalledTimes(MAX_PAIRING_REPAIRS_PER_WINDOW + 1)
  })

  it('does not block a newer pairing stored while the repaired one was being refused', async () => {
    const { state, recovery: deps } = recovery()
    const newer = environment('updated-token', 9)
    deps.ensure.mockImplementationOnce(async () => {
      state.deps.resolve.mockReturnValue(newer)
      throw refusal()
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      buildWithPairingRepair(deps, 'env-1', vi.fn().mockRejectedValue(refusal()))
    ).rejects.toThrow(/refused the new pairing too/)
    warn.mockRestore()
    expect(state.repairs.standingFailure('env-1', pairingRevisionOf(newer))).toBeNull()
    const build = vi.fn().mockResolvedValue(undefined)
    await expect(buildWithPairingRepair(deps, 'env-1', build)).resolves.toBe('built')
    expect(build).toHaveBeenCalledWith(newer)
  })

  it('keeps a connect pressed during the post-repair handshake from being undone', async () => {
    const { state, recovery: deps } = recovery()
    deps.ensure.mockImplementationOnce(async () => {
      state.repairs.forgetFailures('env-1')
      throw refusal()
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      buildWithPairingRepair(deps, 'env-1', vi.fn().mockRejectedValue(refusal()))
    ).rejects.toThrow(/refused the new pairing too/)
    warn.mockRestore()
    expect(state.repairs.standingFailure('env-1', state.refuseCurrent())).toBeNull()
  })

  it('fails clearly, without looping, when the new pairing is refused too', async () => {
    const { state, recovery: deps } = recovery()
    deps.ensure.mockRejectedValue(refusal())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = buildWithPairingRepair(deps, 'env-1', vi.fn().mockRejectedValue(refusal()))
    await expect(failure).rejects.toBeInstanceOf(OrcadManagedPairingRepairFailedError)
    await expect(failure).rejects.toThrow(/refused the new pairing too/)
    warn.mockRestore()
    expect(deps.ensure).toHaveBeenCalledOnce()
    expect(state.deps.refresh).toHaveBeenCalledOnce()
  })
})
