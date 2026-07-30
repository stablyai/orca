import { describe, expect, it, vi } from 'vitest'
import { subscribeSshPtyNotifications } from './ssh-pty-notification-routing'
import type { PtySourceReceivingActivation } from '../../shared/pty-source-receiving-activation'

type MockMux = {
  onNotification: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
}

function createSubscription() {
  const mux: MockMux = {
    onNotification: vi.fn(),
    request: vi.fn(async () => ({ canceled: true, sentEndSu: 0, creditedEndSu: 0 }))
  }
  const dataListeners = new Set<(payload: { id: string; data: string }) => void>()
  const replayListeners = new Set<(payload: { id: string; data: string }) => void>()
  const exitListeners = new Set<(payload: { id: string; code: number }) => void>()
  const livePtyIds = new Set<string>()
  const recordExit = vi.fn()
  const toAppPtyId = vi.fn((id: string) => `ssh:conn@@${id}`)
  const resolvePtyIncarnation = vi.fn((id: string) => `incarnation:${id}`)

  const subscription = subscribeSshPtyNotifications({
    mux: mux as never,
    toAppPtyId,
    dataListeners: dataListeners as never,
    replayListeners: replayListeners as never,
    exitListeners: exitListeners as never,
    livePtyIds,
    recordExit,
    providerGeneration: 7,
    resolvePtyIncarnation
  })

  const handler = mux.onNotification.mock.calls[0]?.[0] as (
    method: string,
    params: Record<string, unknown>
  ) => void
  if (!handler) {
    throw new Error('notification handler was not registered')
  }

  return {
    handler,
    mux,
    toAppPtyId,
    dataListeners,
    replayListeners,
    exitListeners,
    livePtyIds,
    recordExit,
    resolvePtyIncarnation,
    installReceivingActivation: subscription.installReceivingActivation
  }
}

function sourceActivation(
  overrides: Partial<PtySourceReceivingActivation> = {}
): PtySourceReceivingActivation {
  return Object.freeze({
    status: 'pending',
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: 'incarnation-1',
    deliveryToken: 'token-1',
    checkpointSourceEndSu: 0,
    recoveryEndSu: 0,
    ...overrides
  })
}

describe('subscribeSshPtyNotifications', () => {
  it('ignores non-PTY notifications without mapping params.id', () => {
    const { handler, toAppPtyId } = createSubscription()

    expect(() => handler('workspace.changed', { snapshot: { revision: 1 } })).not.toThrow()
    expect(() =>
      handler('fs.changed', {
        events: [{ kind: 'update', absolutePath: '/tmp/repo/file.txt' }]
      })
    ).not.toThrow()
    expect(toAppPtyId).not.toHaveBeenCalled()
  })

  it('routes pty.data after validating the string id', () => {
    const { handler, toAppPtyId, dataListeners, livePtyIds } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)

    handler('pty.data', { id: 'pty-1', data: 'hello', rawLength: 5, seq: 9 })

    expect(toAppPtyId).toHaveBeenCalledWith('pty-1')
    expect(livePtyIds.has('ssh:conn@@pty-1')).toBe(true)
    expect(onData).toHaveBeenCalledWith({
      id: 'ssh:conn@@pty-1',
      data: 'hello',
      providerGeneration: 7,
      ptyIncarnation: 'incarnation:pty-1',
      sequenceChars: 5,
      seq: 9
    })
  })

  it('records pty.exit with the validated relay id', () => {
    const { handler, exitListeners, livePtyIds, recordExit } = createSubscription()
    const onExit = vi.fn()
    exitListeners.add(onExit)
    livePtyIds.add('ssh:conn@@pty-1')

    handler('pty.exit', {
      id: 'pty-1',
      code: 0,
      incarnationId: 'incarnation-1'
    })

    expect(recordExit).toHaveBeenCalledWith('pty-1', 'incarnation-1')
    expect(livePtyIds.has('ssh:conn@@pty-1')).toBe(false)
    expect(onExit).toHaveBeenCalledWith({
      id: 'ssh:conn@@pty-1',
      code: 0,
      providerGeneration: 7,
      ptyIncarnation: 'incarnation:pty-1',
      incarnationId: 'incarnation-1'
    })
  })

  it('derives exact immutable source ranges and cancels malformed frames without side effects', () => {
    const {
      handler,
      mux,
      dataListeners,
      livePtyIds,
      toAppPtyId,
      resolvePtyIncarnation,
      installReceivingActivation
    } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    livePtyIds.add('ssh:conn@@unrelated')
    installReceivingActivation(
      'pty-1',
      sourceActivation({ checkpointSourceEndSu: 10, recoveryEndSu: 14 })
    ).commit()

    handler('pty.data', {
      id: 'pty-1',
      data: 'data',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 14,
      sourceLengthSu: 4
    })
    const acceptedSource = onData.mock.calls[0]?.[0].source
    expect(Object.isFrozen(acceptedSource)).toBe(true)
    const liveBeforeMalformed = new Set(livePtyIds)
    toAppPtyId.mockClear()
    resolvePtyIncarnation.mockClear()
    handler('pty.data', {
      id: 'pty-1',
      data: 'bad',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 17,
      sourceLengthSu: 4
    })

    expect(onData.mock.calls[0]?.[0]).toMatchObject({
      source: {
        relayPtyId: 'pty-1',
        spanId: 'token-1:10:14',
        clientGeneration: 2,
        ownerGeneration: 3,
        deliveryToken: 'token-1',
        sourceStartSu: 10,
        sourceEndSu: 14
      }
    })
    expect(onData).toHaveBeenCalledTimes(1)
    expect(livePtyIds).toEqual(liveBeforeMalformed)
    expect(toAppPtyId).not.toHaveBeenCalled()
    expect(resolvePtyIncarnation).not.toHaveBeenCalled()
    expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
      id: 'pty-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token-1'
    })
  })

  it('keeps exact source incarnation independent without mutating legacy delivery state', () => {
    const { handler, dataListeners, resolvePtyIncarnation, installReceivingActivation } =
      createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    handler('pty.data', { id: 'pty-1', data: 'legacy' })
    installReceivingActivation(
      'pty-1',
      sourceActivation({ checkpointSourceEndSu: 0, recoveryEndSu: 4 })
    ).commit()
    handler('pty.data', {
      id: 'pty-1',
      data: 'data',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 4,
      sourceLengthSu: 4
    })

    expect(onData.mock.calls.map(([payload]) => payload.ptyIncarnation)).toEqual([
      'incarnation:pty-1',
      'incarnation-1'
    ])
    expect(resolvePtyIncarnation).toHaveBeenCalledTimes(1)
    expect(resolvePtyIncarnation).toHaveBeenCalledWith('pty-1', undefined)
  })

  it('drops stale delivery generations without touching their PTY or unrelated PTYs', () => {
    const {
      handler,
      mux,
      dataListeners,
      livePtyIds,
      toAppPtyId,
      resolvePtyIncarnation,
      installReceivingActivation
    } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    livePtyIds.add('ssh:conn@@unrelated')
    installReceivingActivation(
      'pty-1',
      sourceActivation({
        clientGeneration: 4,
        ownerGeneration: 5,
        deliveryToken: 'token-new',
        recoveryEndSu: 3
      })
    ).commit()

    handler('pty.data', {
      id: 'pty-1',
      data: 'new',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-new',
      clientGeneration: 4,
      ownerGeneration: 5,
      sourceEndSu: 3,
      sourceLengthSu: 3
    })
    const liveBeforeStale = new Set(livePtyIds)
    toAppPtyId.mockClear()
    resolvePtyIncarnation.mockClear()

    handler('pty.data', {
      id: 'pty-1',
      data: 'old',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-old',
      clientGeneration: 3,
      ownerGeneration: 4,
      sourceEndSu: 6,
      sourceLengthSu: 3
    })

    expect(onData).toHaveBeenCalledTimes(1)
    expect(livePtyIds).toEqual(liveBeforeStale)
    expect(toAppPtyId).not.toHaveBeenCalled()
    expect(resolvePtyIncarnation).not.toHaveBeenCalled()
    expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
      id: 'pty-1',
      clientGeneration: 3,
      ownerGeneration: 4,
      deliveryToken: 'token-old'
    })
  })

  it('rejects same-generation token changes and source discontinuities', () => {
    const { handler, mux, dataListeners, installReceivingActivation } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    const sourceParams = {
      id: 'pty-1',
      ptyIncarnation: 'incarnation-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceLengthSu: 3
    }
    installReceivingActivation('pty-1', sourceActivation({ recoveryEndSu: 3 })).commit()

    handler('pty.data', {
      ...sourceParams,
      data: 'one',
      deliveryToken: 'token-1',
      sourceEndSu: 3
    })
    handler('pty.data', {
      ...sourceParams,
      data: 'two',
      deliveryToken: 'token-2',
      sourceEndSu: 6
    })
    handler('pty.data', {
      ...sourceParams,
      data: 'gap',
      deliveryToken: 'token-1',
      sourceEndSu: 9
    })
    handler('pty.data', {
      ...sourceParams,
      data: 'two',
      deliveryToken: 'token-1',
      sourceEndSu: 6
    })

    expect(onData.mock.calls.map((call) => call[0].data)).toEqual(['one', 'two'])
    expect(mux.request).toHaveBeenCalledTimes(2)
    expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
      id: 'pty-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token-2'
    })
    expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
      id: 'pty-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token-1'
    })
  })

  it('accepts a strictly newer rotation, rejects late old data, and preserves new continuity', () => {
    const { handler, mux, dataListeners, installReceivingActivation } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    const frame = (
      data: string,
      deliveryToken: string,
      clientGeneration: number,
      ownerGeneration: number,
      sourceEndSu: number
    ) => ({
      id: 'pty-1',
      data,
      ptyIncarnation: 'incarnation-1',
      deliveryToken,
      clientGeneration,
      ownerGeneration,
      sourceEndSu,
      sourceLengthSu: data.length
    })

    installReceivingActivation(
      'pty-1',
      sourceActivation({ deliveryToken: 'token-old', recoveryEndSu: 3 })
    ).commit()
    handler('pty.data', frame('old', 'token-old', 2, 3, 3))
    installReceivingActivation(
      'pty-1',
      sourceActivation({
        clientGeneration: 3,
        ownerGeneration: 4,
        deliveryToken: 'token-new',
        checkpointSourceEndSu: 10,
        recoveryEndSu: 13
      })
    ).commit()
    handler('pty.data', frame('new', 'token-new', 3, 4, 13))
    handler('pty.data', frame('old', 'token-old', 2, 3, 6))
    handler('pty.data', frame('next', 'token-new', 3, 4, 17))

    expect(onData.mock.calls.map((call) => call[0].data)).toEqual(['old', 'new', 'next'])
    expect(mux.request).toHaveBeenCalledTimes(1)
    expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
      id: 'pty-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token-old'
    })
  })

  it.each([
    ['client-only advance', 3, 3, 'token-client'],
    ['owner-only advance', 2, 4, 'token-owner'],
    ['crossed generations', 3, 2, 'token-crossed'],
    ['replayed client generation', 1, 4, 'token-replayed'],
    ['reused token on newer generations', 3, 4, 'token-current']
  ])(
    'rejects a %s without replacing the accepted continuity record',
    (_case, clientGeneration, ownerGeneration, deliveryToken) => {
      const {
        handler,
        mux,
        dataListeners,
        livePtyIds,
        toAppPtyId,
        resolvePtyIncarnation,
        installReceivingActivation
      } = createSubscription()
      const onData = vi.fn()
      dataListeners.add(onData)
      const base = {
        id: 'pty-1',
        ptyIncarnation: 'incarnation-1',
        sourceLengthSu: 3
      }
      installReceivingActivation(
        'pty-1',
        sourceActivation({ deliveryToken: 'token-current', recoveryEndSu: 3 })
      ).commit()
      handler('pty.data', {
        ...base,
        data: 'one',
        deliveryToken: 'token-current',
        clientGeneration: 2,
        ownerGeneration: 3,
        sourceEndSu: 3
      })
      const liveBeforeInvalid = new Set(livePtyIds)
      toAppPtyId.mockClear()
      resolvePtyIncarnation.mockClear()

      handler('pty.data', {
        ...base,
        data: 'bad',
        deliveryToken,
        clientGeneration,
        ownerGeneration,
        sourceEndSu: 6
      })
      handler('pty.data', {
        ...base,
        data: 'two',
        deliveryToken: 'token-current',
        clientGeneration: 2,
        ownerGeneration: 3,
        sourceEndSu: 6
      })

      expect(onData.mock.calls.map((call) => call[0].data)).toEqual(['one', 'two'])
      expect(livePtyIds).toEqual(liveBeforeInvalid)
      expect(toAppPtyId).toHaveBeenCalledTimes(1)
      expect(resolvePtyIncarnation).not.toHaveBeenCalled()
      expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
        id: 'pty-1',
        clientGeneration,
        ownerGeneration,
        deliveryToken
      })
    }
  )

  it('does not cancel an incomplete malformed identity or mutate provider state', () => {
    const { handler, mux, dataListeners, livePtyIds, toAppPtyId, resolvePtyIncarnation } =
      createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    livePtyIds.add('ssh:conn@@unrelated')

    handler('pty.data', {
      id: 'pty-1',
      data: 'bad',
      ptyIncarnation: 'incarnation-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 3,
      sourceLengthSu: 3
    })

    expect(onData).not.toHaveBeenCalled()
    expect(livePtyIds).toEqual(new Set(['ssh:conn@@unrelated']))
    expect(toAppPtyId).not.toHaveBeenCalled()
    expect(resolvePtyIncarnation).not.toHaveBeenCalled()
    expect(mux.request).not.toHaveBeenCalled()
  })

  it('accepts non-empty recovery from the activation checkpoint', () => {
    const { handler, dataListeners, installReceivingActivation } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    const lease = installReceivingActivation(
      'pty-1',
      sourceActivation({ checkpointSourceEndSu: 4, recoveryEndSu: 8 })
    )

    handler('pty.data', {
      id: 'pty-1',
      data: 'next',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 8,
      sourceLengthSu: 4
    })

    expect(onData).not.toHaveBeenCalled()
    lease.commit()
    expect(onData).toHaveBeenCalledWith(
      expect.objectContaining({
        data: 'next',
        source: expect.objectContaining({ sourceStartSu: 4, sourceEndSu: 8 })
      })
    )
  })

  it('routes held and later recovery frames only to the private sink until commit', () => {
    const { handler, dataListeners, livePtyIds, installReceivingActivation } = createSubscription()
    const onData = vi.fn()
    const onRecoveryData = vi.fn()
    dataListeners.add(onData)
    const lease = installReceivingActivation(
      'pty-1',
      sourceActivation({ checkpointSourceEndSu: 4, recoveryEndSu: 12 })
    )
    const publishSource = (data: string, sourceEndSu: number): void => {
      handler('pty.data', {
        id: 'pty-1',
        data,
        ptyIncarnation: 'incarnation-1',
        deliveryToken: 'token-1',
        clientGeneration: 2,
        ownerGeneration: 3,
        sourceEndSu,
        sourceLengthSu: 4
      })
    }

    publishSource('held', 8)
    const recoveryLease = lease.transferToRecovery(onRecoveryData)
    publishSource('next', 12)

    expect(onRecoveryData.mock.calls.map(([payload]) => payload.data)).toEqual(['held', 'next'])
    expect(onData).not.toHaveBeenCalled()
    expect(livePtyIds).not.toContain('ssh:conn@@pty-1')

    recoveryLease.commit()
    expect(onData).not.toHaveBeenCalled()
    publishSource('live', 16)

    expect(onRecoveryData).toHaveBeenCalledTimes(2)
    expect(onData).toHaveBeenCalledWith(expect.objectContaining({ data: 'live' }))
    expect(livePtyIds).toContain('ssh:conn@@pty-1')
  })

  it('retires an exited private recovery when its activation commits', () => {
    const { handler, mux, dataListeners, livePtyIds, installReceivingActivation } =
      createSubscription()
    const onData = vi.fn()
    const onRecoveryData = vi.fn()
    dataListeners.add(onData)
    const lease = installReceivingActivation('pty-1', sourceActivation({ recoveryEndSu: 4 }))
    handler('pty.data', {
      id: 'pty-1',
      data: 'held',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 4,
      sourceLengthSu: 4
    })
    const recoveryLease = lease.transferToRecovery(onRecoveryData)

    handler('pty.exit', { id: 'pty-1', code: 0, incarnationId: 'incarnation-1' })
    recoveryLease.commit()
    handler('pty.data', {
      id: 'pty-1',
      data: 'late',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 8,
      sourceLengthSu: 4
    })

    expect(onRecoveryData).toHaveBeenCalledOnce()
    expect(onData).not.toHaveBeenCalled()
    expect(livePtyIds).not.toContain('ssh:conn@@pty-1')
    expect(mux.request).toHaveBeenCalledWith(
      'pty.cancelDelivery',
      expect.objectContaining({ id: 'pty-1', deliveryToken: 'token-1' })
    )
  })

  it('retires private recovery locally and restores the exact predecessor', () => {
    const { handler, mux, dataListeners, installReceivingActivation } = createSubscription()
    const onData = vi.fn()
    const onRecoveryData = vi.fn()
    dataListeners.add(onData)
    installReceivingActivation(
      'pty-1',
      sourceActivation({ deliveryToken: 'token-old', recoveryEndSu: 3 })
    ).commit()
    handler('pty.data', {
      id: 'pty-1',
      data: 'pre',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-old',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 3,
      sourceLengthSu: 3
    })
    const replacement = installReceivingActivation(
      'pty-1',
      sourceActivation({
        clientGeneration: 3,
        ownerGeneration: 4,
        deliveryToken: 'token-new',
        checkpointSourceEndSu: 3,
        recoveryEndSu: 6
      })
    )
    handler('pty.data', {
      id: 'pty-1',
      data: 'new',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-new',
      clientGeneration: 3,
      ownerGeneration: 4,
      sourceEndSu: 6,
      sourceLengthSu: 3
    })

    replacement.transferToRecovery(onRecoveryData).retire()
    handler('pty.data', {
      id: 'pty-1',
      data: 'old',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-old',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 6,
      sourceLengthSu: 3
    })

    expect(onRecoveryData).toHaveBeenCalledWith(expect.objectContaining({ data: 'new' }))
    expect(onData.mock.calls.map(([payload]) => payload.data)).toEqual(['pre', 'old'])
    expect(mux.request).not.toHaveBeenCalled()
  })

  it('rejects a stale activation without disturbing current continuity', () => {
    const { handler, dataListeners, installReceivingActivation } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    installReceivingActivation('pty-1', sourceActivation({ recoveryEndSu: 3 })).commit()

    expect(() =>
      installReceivingActivation(
        'pty-1',
        sourceActivation({
          clientGeneration: 1,
          ownerGeneration: 4,
          deliveryToken: 'token-stale',
          checkpointSourceEndSu: 3,
          recoveryEndSu: 3
        })
      )
    ).toThrow('ssh_source_receiving_activation_stale')

    handler('pty.data', {
      id: 'pty-1',
      data: 'one',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 3,
      sourceLengthSu: 3
    })
    expect(onData).toHaveBeenCalledOnce()
  })

  it('drops provisional frames and settles cancellation before rollback completes', async () => {
    const { handler, mux, dataListeners, livePtyIds, installReceivingActivation } =
      createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    const lease = installReceivingActivation(
      'pty-1',
      sourceActivation({ checkpointSourceEndSu: 4, recoveryEndSu: 8 })
    )
    handler('pty.data', {
      id: 'pty-1',
      data: 'next',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 8,
      sourceLengthSu: 4
    })

    await expect(lease.rollback()).resolves.toBe(true)

    expect(onData).not.toHaveBeenCalled()
    expect(livePtyIds).not.toContain('ssh:conn@@pty-1')
    expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
      id: 'pty-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token-1'
    })
  })

  it('restores the exact prior cursor when a replacement rolls back after frames', async () => {
    const { handler, dataListeners, installReceivingActivation } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    installReceivingActivation('pty-1', sourceActivation({ deliveryToken: 'token-old' })).commit()
    handler('pty.data', {
      id: 'pty-1',
      data: 'pre',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-old',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 3,
      sourceLengthSu: 3
    })
    const replacement = installReceivingActivation(
      'pty-1',
      sourceActivation({
        clientGeneration: 3,
        ownerGeneration: 4,
        deliveryToken: 'token-new',
        checkpointSourceEndSu: 3,
        recoveryEndSu: 3
      })
    )
    handler('pty.data', {
      id: 'pty-1',
      data: 'new',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-new',
      clientGeneration: 3,
      ownerGeneration: 4,
      sourceEndSu: 6,
      sourceLengthSu: 3
    })

    await replacement.rollback()
    handler('pty.data', {
      id: 'pty-1',
      data: 'old',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-old',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 6,
      sourceLengthSu: 3
    })

    expect(onData.mock.calls.map(([payload]) => payload.data)).toEqual(['pre', 'old'])
  })

  it('does not let an older lease rollback replace a newer activation', async () => {
    const { handler, mux, dataListeners, installReceivingActivation } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    const older = installReceivingActivation('pty-1', sourceActivation())
    const newer = installReceivingActivation(
      'pty-1',
      sourceActivation({
        clientGeneration: 3,
        ownerGeneration: 4,
        deliveryToken: 'token-new'
      })
    )

    await older.rollback()
    handler('pty.data', {
      id: 'pty-1',
      data: 'new',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-new',
      clientGeneration: 3,
      ownerGeneration: 4,
      sourceEndSu: 3,
      sourceLengthSu: 3
    })
    newer.commit()

    expect(onData).toHaveBeenCalledWith(expect.objectContaining({ data: 'new' }))
    expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
      id: 'pty-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token-1'
    })
    expect(mux.request).not.toHaveBeenCalledWith(
      'pty.cancelDelivery',
      expect.objectContaining({ deliveryToken: 'token-new' })
    )
  })

  it('ignores PTY methods with missing ids', () => {
    const { handler, toAppPtyId, dataListeners } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)

    expect(() => handler('pty.data', { data: 'orphan' })).not.toThrow()
    expect(toAppPtyId).not.toHaveBeenCalled()
    expect(onData).not.toHaveBeenCalled()
  })

  it('leaves recovery and cancellation control methods to their dedicated handlers', () => {
    const {
      handler,
      mux,
      toAppPtyId,
      dataListeners,
      replayListeners,
      exitListeners,
      livePtyIds,
      recordExit,
      resolvePtyIncarnation
    } = createSubscription()
    const onData = vi.fn()
    const onReplay = vi.fn()
    const onExit = vi.fn()
    dataListeners.add(onData)
    replayListeners.add(onReplay)
    exitListeners.add(onExit)
    livePtyIds.add('ssh:conn@@unrelated')

    for (const method of [
      'pty.recoveryData',
      'pty.recoveryComplete',
      'pty.restoreRequired',
      'pty.deliveryCanceled'
    ]) {
      handler(method, {
        id: 'pty-1',
        data: 'control',
        deliveryToken: 'token-1',
        clientGeneration: 2,
        ownerGeneration: 3
      })
    }

    expect(toAppPtyId).not.toHaveBeenCalled()
    expect(resolvePtyIncarnation).not.toHaveBeenCalled()
    expect(recordExit).not.toHaveBeenCalled()
    expect(onData).not.toHaveBeenCalled()
    expect(onReplay).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    expect(livePtyIds).toEqual(new Set(['ssh:conn@@unrelated']))
    expect(mux.request).not.toHaveBeenCalled()
  })
})
