import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshPtyDataCallback } from '../providers/ssh-pty-provider-contract'
import type { SshPtyProvider } from '../providers/ssh-pty-provider'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { SshPtyConsumerSessionState } from './ssh-pty-consumer-session'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps } from './ssh-relay-session-test-fixtures'

const { acceptOutputDataMock, getSshPtyProviderMock } = vi.hoisted(() => ({
  acceptOutputDataMock: vi.fn().mockResolvedValue(undefined),
  getSshPtyProviderMock: vi.fn()
}))

vi.mock('../ipc/ssh-pty-output-intake-registry', async (importOriginal) => {
  const original = (await importOriginal()) as object
  return { ...original, acceptSshPtyOutputData: acceptOutputDataMock }
})

vi.mock('../ipc/pty', async (importOriginal) => {
  const original = (await importOriginal()) as object
  return { ...original, getSshPtyProvider: getSshPtyProviderMock }
})

type SshPtyDataPayload = Parameters<SshPtyDataCallback>[0]

type RejectedDeliverySession = {
  mux: SshChannelMultiplexer | null
  activePtyProviderGeneration: number | null
  ptyConsumerSessionState: SshPtyConsumerSessionState | null
  acceptPtyData: (payload: SshPtyDataPayload) => Promise<unknown>
  reattachKnownPty: (args: {
    ptyId: string
    activeLeaseByPtyId: Map<string, unknown>
    expectedIdentityByPtyId: Map<string, unknown>
    attachedLeaseIds: Set<string>
    targetedDeliveryRecovery?: 'confirm-existing' | 'fresh-activation'
  }) => Promise<void>
  reattachRejectedPty: (
    relayPtyId: string,
    mux: SshChannelMultiplexer,
    providerGeneration: number,
    targetedDeliveryRecovery: 'confirm-existing' | 'fresh-activation'
  ) => Promise<boolean>
  sourceRecoveryRequest: (appPtyId: string) => Promise<
    | {
        status: 'checkpoint'
        clientGeneration: number
        ownerGeneration: number
        ptyIncarnation: string
        deliveryToken: string
        acceptedSourceEndSu: number
      }
    | undefined
  >
  rejectedPtyRecoveryAttempts: Map<string, unknown>
  sourceIdentityByRelayPtyId: Map<string, unknown>
  retireExitedPty: (payload: {
    id: string
    code: number
    providerGeneration: number
    ptyIncarnation: string
  }) => void
}

function source(overrides: Partial<NonNullable<SshPtyDataPayload['source']>> = {}) {
  return {
    relayPtyId: 'pty-bad',
    spanId: 'token-bad:0:4',
    clientGeneration: 1,
    ownerGeneration: 1,
    deliveryToken: 'token-bad',
    sourceStartSu: 0,
    sourceEndSu: 4,
    ...overrides
  }
}

function rejectedPayload(overrides: Partial<SshPtyDataPayload> = {}): SshPtyDataPayload {
  return {
    id: 'ssh:target-1@@pty-bad',
    data: 'rejected',
    providerGeneration: 23,
    ptyIncarnation: 'incarnation-bad',
    source: source(),
    sourceRejected: true,
    ...overrides
  }
}

function prepareSession() {
  const deps = createMockDeps()
  const mux = {
    isDisposed: vi.fn(() => false),
    dispose: vi.fn()
  } as unknown as SshChannelMultiplexer
  const session = new SshRelaySession(
    'target-1',
    deps.getMainWindow,
    deps.mockStore,
    deps.mockPortForward
  )
  const internals = session as unknown as RejectedDeliverySession
  internals.mux = mux
  internals.activePtyProviderGeneration = 23
  internals.ptyConsumerSessionState = {
    mode: 'negotiated',
    clientInstanceId: 'client-1',
    clientGeneration: 1,
    ownerGeneration: 1,
    ownerLease: 'owner-lease',
    outputFlowControl: { version: 1, windowSu: 64 }
  }
  return { deps, internals, mux, session }
}

describe('SshRelaySession rejected PTY delivery recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('quarantines source-less output queued before a flow-control grant', async () => {
    const { internals, mux } = prepareSession()
    const reattach = vi.fn().mockResolvedValue(true)
    internals.reattachRejectedPty = reattach
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await internals.acceptPtyData(rejectedPayload({ source: undefined, sourceRejected: undefined }))

    expect(warn).toHaveBeenCalledWith(
      '[ssh-relay-session] Rejected PTY delivery',
      expect.objectContaining({
        sourceState: 'source-missing',
        recoveryAction: 'quarantine-legacy-frame'
      })
    )
    expect(reattach).not.toHaveBeenCalled()
    expect(acceptOutputDataMock).not.toHaveBeenCalled()
    expect(mux.dispose).not.toHaveBeenCalled()
  })

  it.each([
    ['client', 9, 1],
    ['owner', 1, 9]
  ] as const)(
    'retires a superseded %s generation without disposing the mux',
    async (_generation, clientGeneration, ownerGeneration) => {
      const { internals, mux } = prepareSession()
      const reattach = vi.fn().mockResolvedValue(true)
      internals.reattachRejectedPty = reattach
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      await internals.acceptPtyData(
        rejectedPayload({ source: source({ clientGeneration, ownerGeneration }) })
      )

      expect(reattach).toHaveBeenCalledWith('pty-bad', mux, 23, 'confirm-existing')
      expect(acceptOutputDataMock).not.toHaveBeenCalled()
      expect(mux.dispose).not.toHaveBeenCalled()
    }
  )

  it('logs malformed source metadata and reattaches from the exact outer PTY identity', async () => {
    const { internals } = prepareSession()
    const reattach = vi.fn().mockResolvedValue(true)
    internals.reattachRejectedPty = reattach
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await internals.acceptPtyData(
      rejectedPayload({ source: undefined, sourceMalformed: true, sourceRejected: undefined })
    )

    expect(warn).toHaveBeenCalledWith(
      '[ssh-relay-session] Rejected PTY delivery',
      expect.objectContaining({
        ptyId: 'ssh:target-1@@pty-bad',
        providerGeneration: 23,
        expectedClientGeneration: 1,
        expectedOwnerGeneration: 1,
        sourceState: 'source-malformed',
        recoveryAction: 'retire-and-reattach-delivery'
      })
    )
    expect(reattach).toHaveBeenCalledWith('pty-bad', expect.anything(), 23, 'confirm-existing')
    expect(acceptOutputDataMock).not.toHaveBeenCalled()
  })

  it('reattaches only the rejected PTY while a healthy sibling keeps delivering', async () => {
    const { deps, internals, mux } = prepareSession()
    const provider = {} as SshPtyProvider
    getSshPtyProviderMock.mockReturnValue(provider)
    vi.mocked(deps.mockStore.getSshRemotePtyLeases).mockReturnValue([
      {
        targetId: 'target-1',
        ptyId: 'pty-bad',
        state: 'detached',
        createdAt: 1,
        updatedAt: 1
      },
      {
        targetId: 'target-1',
        ptyId: 'pty-healthy',
        state: 'attached',
        createdAt: 1,
        updatedAt: 1
      }
    ])
    const reattachKnownPty = vi.fn(
      async (args: Parameters<RejectedDeliverySession['reattachKnownPty']>[0]) => {
        args.attachedLeaseIds.add(args.ptyId)
      }
    )
    internals.reattachKnownPty = reattachKnownPty

    await internals.acceptPtyData(rejectedPayload({ rejectedSourceRecovery: 'fresh-activation' }))
    await vi.waitFor(() => expect(reattachKnownPty).toHaveBeenCalledOnce())
    await internals.acceptPtyData(
      rejectedPayload({
        id: 'ssh:target-1@@pty-healthy',
        data: 'healthy',
        ptyIncarnation: 'incarnation-healthy',
        source: source({
          relayPtyId: 'pty-healthy',
          spanId: 'token-healthy:0:7',
          deliveryToken: 'token-healthy',
          sourceEndSu: 7
        }),
        sourceRejected: undefined
      })
    )

    const recovery = reattachKnownPty.mock.calls[0]?.[0]
    expect(recovery?.ptyId).toBe('pty-bad')
    expect(Array.from(recovery?.activeLeaseByPtyId.keys() ?? [])).toEqual(['pty-bad'])
    expect(Array.from(recovery?.expectedIdentityByPtyId.keys() ?? [])).toEqual([])
    expect(recovery?.targetedDeliveryRecovery).toBe('fresh-activation')
    expect(deps.mockStore.markSshRemotePtyLeasesAttachedAsync).toHaveBeenCalledWith('target-1', [
      'pty-bad'
    ])
    expect(acceptOutputDataMock).toHaveBeenCalledOnce()
    expect(acceptOutputDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ssh:target-1@@pty-healthy', data: 'healthy' })
    )
    expect(mux.dispose).not.toHaveBeenCalled()
  })

  it('reconnects instead of canceling an unprovable malformed delivery', async () => {
    const { internals, mux } = prepareSession()
    const reattach = vi.fn().mockResolvedValue(true)
    internals.reattachRejectedPty = reattach
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await internals.acceptPtyData(
      rejectedPayload({
        source: undefined,
        sourceMalformed: true,
        sourceRejected: undefined,
        rejectedSourceRecovery: 'reconnect-channel'
      })
    )

    expect(mux.dispose).toHaveBeenCalledWith('connection_lost')
    expect(reattach).not.toHaveBeenCalled()
  })

  it('opens a fresh activation after exact rejected-delivery cancellation', async () => {
    const { deps, internals, mux } = prepareSession()
    internals.sourceIdentityByRelayPtyId.set('pty-bad', {
      clientGeneration: 1,
      ownerGeneration: 1,
      ptyIncarnation: 'incarnation-bad',
      deliveryToken: 'token-old',
      nextSourceSu: 4
    })
    const commit = vi.fn()
    const attachForReconnect = vi.fn(async () => ({
      incarnationId: 'incarnation-bad',
      sourceActivation: {
        status: 'pending' as const,
        clientGeneration: 1,
        ownerGeneration: 1,
        ptyIncarnation: 'incarnation-bad',
        deliveryToken: 'token-fresh',
        checkpointSourceEndSu: 0,
        recoveryEndSu: 0
      },
      sourceActivationLease: { commit, rollback: vi.fn(async () => true) }
    }))
    getSshPtyProviderMock.mockReturnValue({ attachForReconnect } as unknown as SshPtyProvider)

    await expect(
      internals.reattachRejectedPty('pty-bad', mux, 23, 'fresh-activation')
    ).resolves.toBe(true)

    expect(attachForReconnect).toHaveBeenCalledWith('pty-bad')
    expect(commit).toHaveBeenCalledOnce()
    expect(deps.mockStore.markSshRemotePtyLeasesAttachedAsync).toHaveBeenCalledWith('target-1', [
      'pty-bad'
    ])
    await internals.acceptPtyData(
      rejectedPayload({
        data: 'fresh',
        sourceRejected: undefined,
        source: source({ deliveryToken: 'token-fresh' })
      })
    )
    expect(acceptOutputDataMock).toHaveBeenCalledWith(expect.objectContaining({ data: 'fresh' }))
    expect(mux.dispose).not.toHaveBeenCalled()
  })

  it('accepts an exact existing activation as stale-frame confirmation', async () => {
    const { internals, mux } = prepareSession()
    const checkpoint = {
      status: 'checkpoint' as const,
      clientGeneration: 1,
      ownerGeneration: 1,
      ptyIncarnation: 'incarnation-bad',
      deliveryToken: 'token-current',
      acceptedSourceEndSu: 7
    }
    internals.sourceRecoveryRequest = vi.fn(async () => checkpoint)
    const commit = vi.fn()
    const attachForReconnect = vi.fn(async () => ({
      incarnationId: 'incarnation-bad',
      sourceActivation: {
        status: 'pending' as const,
        clientGeneration: 1,
        ownerGeneration: 1,
        ptyIncarnation: 'incarnation-bad',
        deliveryToken: 'token-current',
        checkpointSourceEndSu: 0,
        recoveryEndSu: 0
      },
      sourceActivationLease: { commit, rollback: vi.fn(async () => true) }
    }))
    getSshPtyProviderMock.mockReturnValue({ attachForReconnect } as unknown as SshPtyProvider)

    await expect(
      internals.reattachRejectedPty('pty-bad', mux, 23, 'confirm-existing')
    ).resolves.toBe(true)

    expect(attachForReconnect).toHaveBeenCalledWith('pty-bad', undefined, checkpoint)
    expect(commit).toHaveBeenCalledOnce()
    expect(mux.dispose).not.toHaveBeenCalled()
  })

  it('forgets rejected-delivery recovery history when the PTY exits', () => {
    const { internals } = prepareSession()
    internals.rejectedPtyRecoveryAttempts.set('ssh:target-1@@pty-bad', {})

    internals.retireExitedPty({
      id: 'ssh:target-1@@pty-bad',
      code: 0,
      providerGeneration: 23,
      ptyIncarnation: 'incarnation-bad'
    })

    expect(internals.rejectedPtyRecoveryAttempts).toHaveLength(0)
  })

  // Why a channel drop rather than a terminal relay error: a terminal error clears the reconnect
  // backoff and rotates provider authority, aborting every fs and git request on the target, so one
  // PTY's undeliverable output would strand the whole connection in manual recovery.
  it('bounds failed targeted recovery and escalates to a recoverable relay reconnect', async () => {
    const { internals, mux, session } = prepareSession()
    const reattach = vi.fn().mockResolvedValue(false)
    internals.reattachRejectedPty = reattach
    getSshPtyProviderMock.mockReturnValue({ hasPty: () => true } as unknown as SshPtyProvider)
    const onTerminalError = vi.fn()
    session.setOnTerminalRelayError(onTerminalError)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await internals.acceptPtyData(rejectedPayload())
    await vi.waitFor(() => expect(mux.dispose).toHaveBeenCalledOnce(), { timeout: 2000 })

    expect(reattach).toHaveBeenCalledTimes(2)
    expect(reattach.mock.calls).toEqual([
      ['pty-bad', mux, 23, 'confirm-existing'],
      ['pty-bad', mux, 23, 'confirm-existing']
    ])
    expect(mux.dispose).toHaveBeenCalledWith('connection_lost')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('PTY pty-bad delivery recovery exhausted')
    )
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(acceptOutputDataMock).not.toHaveBeenCalled()
  })

  it('stops without an error when the rejected PTY exited during recovery', async () => {
    const { internals, mux, session } = prepareSession()
    const reattach = vi.fn().mockResolvedValue(false)
    internals.reattachRejectedPty = reattach
    // Why: reattachKnownPty resolves without claiming the lease when the PTY exits mid-attach, so a
    // plain "not recovered" is indistinguishable from a failure until liveness is checked.
    getSshPtyProviderMock.mockReturnValue({ hasPty: () => false } as unknown as SshPtyProvider)
    const onTerminalError = vi.fn()
    session.setOnTerminalRelayError(onTerminalError)

    await internals.acceptPtyData(rejectedPayload())
    await vi.waitFor(() => expect(reattach).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(reattach).toHaveBeenCalledOnce()
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(mux.dispose).not.toHaveBeenCalled()
  })

  // Why bounded: the bulk reconnect path caps the identical attach work at 8, and a relay that
  // starts rejecting across every PTY at once would otherwise open one attach round trip per PTY.
  it('caps concurrent targeted reattaches and coalesces repeats for one PTY', async () => {
    const { internals } = prepareSession()
    getSshPtyProviderMock.mockReturnValue({ hasPty: () => true } as unknown as SshPtyProvider)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const release: (() => void)[] = []
    let active = 0
    let peak = 0
    const reattach = vi.fn(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => release.push(resolve))
      active--
      return true
    })
    internals.reattachRejectedPty = reattach

    for (let index = 0; index < 20; index++) {
      const relayPtyId = `pty-${index}`
      await internals.acceptPtyData(
        rejectedPayload({
          id: `ssh:target-1@@${relayPtyId}`,
          source: source({ relayPtyId, deliveryToken: `token-${index}` })
        })
      )
      // Why twice: a repeat for a PTY already recovering must not consume a second slot.
      await internals.acceptPtyData(
        rejectedPayload({
          id: `ssh:target-1@@${relayPtyId}`,
          source: source({ relayPtyId, deliveryToken: `token-${index}-repeat` })
        })
      )
    }

    expect(peak).toBe(8)
    expect(reattach).toHaveBeenCalledTimes(8)
    for (const resolve of release.splice(0)) {
      resolve()
    }
    await vi.waitFor(() => expect(reattach).toHaveBeenCalledTimes(16))
    expect(peak).toBe(8)
    for (const resolve of release.splice(0)) {
      resolve()
    }
  })

  it('does not let accepted frames refill the recovery budget indefinitely', async () => {
    const { internals, mux, session } = prepareSession()
    const reattach = vi.fn().mockResolvedValue(true)
    internals.reattachRejectedPty = reattach
    getSshPtyProviderMock.mockReturnValue({ hasPty: () => true } as unknown as SshPtyProvider)
    const onTerminalError = vi.fn()
    session.setOnTerminalRelayError(onTerminalError)

    // Why alternating, with a fresh bad token each round: every rejection retires its own delivery,
    // so a flapping PTY only keeps asking for recovery by moving onto new ones, and the accepted
    // frame in between is what used to clear the budget outright. Each reattach here succeeds, so
    // the consecutive budget is cleared legitimately too — only the per-generation ceiling can stop
    // it.
    for (let round = 0; round < 40; round++) {
      await internals.acceptPtyData(
        rejectedPayload({
          source: source({
            spanId: `token-bad-${round}:0:4`,
            deliveryToken: `token-bad-${round}`,
            clientGeneration: 9
          })
        })
      )
      await internals.acceptPtyData(
        rejectedPayload({
          sourceRejected: undefined,
          source: source({
            spanId: `token-good:${round * 4}:${round * 4 + 4}`,
            deliveryToken: 'token-good',
            sourceStartSu: round * 4,
            sourceEndSu: round * 4 + 4
          })
        })
      )
      await Promise.resolve()
    }
    await vi.waitFor(() => expect(mux.dispose).toHaveBeenCalledOnce(), { timeout: 2000 })

    expect(onTerminalError).not.toHaveBeenCalled()
    expect(acceptOutputDataMock).toHaveBeenCalledTimes(40)
    expect(reattach.mock.calls.length).toBeLessThanOrEqual(12)
  })
})
