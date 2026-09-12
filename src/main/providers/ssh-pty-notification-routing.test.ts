import { describe, expect, it, vi } from 'vitest'
import { createSubscription, sourceActivation } from './ssh-pty-notification-routing-test-fixture'

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

  it('routes ownership-transfer output metadata without changing legacy delivery', () => {
    const onOwnershipTransferOutput = vi.fn()
    const { handler, dataListeners, installReceivingActivation } =
      createSubscription(onOwnershipTransferOutput)
    const onData = vi.fn()
    dataListeners.add(onData)
    installReceivingActivation('pty-1', sourceActivation()).commit()

    const baseEnvelope = {
      bridgeId: 'bridge-1',
      terminalId: 'pty-1',
      incarnationId: 'incarnation-1',
      ownerLease: 'lease-1',
      sourceOwnerGeneration: 3,
      destinationRuntimeId: 'runtime-1',
      version: 1,
      frameSeq: 1,
      frameLengthSu: 4
    }
    handler('pty.data', {
      id: 'pty-1',
      data: 'ab',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 2,
      sourceLengthSu: 2,
      ownershipTransfer: { ...baseEnvelope, fragmentStartSu: 0, fragmentEndSu: 2 }
    })
    handler('pty.data', {
      id: 'pty-1',
      data: 'cd',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 4,
      sourceLengthSu: 2,
      ownershipTransfer: { ...baseEnvelope, fragmentStartSu: 2, fragmentEndSu: 4 }
    })

    expect(onOwnershipTransferOutput).toHaveBeenCalledTimes(2)
    expect(onOwnershipTransferOutput).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: 'cd' })
    )
    expect(onData).toHaveBeenCalledTimes(2)
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

  it('accepts a valid ownership-transfer envelope and rejects an invalid fragment', () => {
    const { handler, dataListeners, installReceivingActivation, mux } = createSubscription()
    const onData = vi.fn()
    dataListeners.add(onData)
    installReceivingActivation('pty-1', sourceActivation({ recoveryEndSu: 4 })).commit()

    const ownershipTransfer = {
      bridgeId: 'bridge-1',
      terminalId: 'pty-1',
      incarnationId: 'incarnation-1',
      ownerLease: 'lease-1',
      sourceOwnerGeneration: 3,
      destinationRuntimeId: 'runtime-1',
      version: 1,
      frameSeq: 11,
      fragmentStartSu: 0,
      fragmentEndSu: 4,
      frameLengthSu: 4
    }
    handler('pty.data', {
      id: 'pty-1',
      data: 'data',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 4,
      sourceLengthSu: 4,
      ownershipTransfer
    })
    expect(onData).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          ownershipTransfer: expect.objectContaining({ frameSeq: 11 })
        })
      })
    )

    handler('pty.data', {
      id: 'pty-1',
      data: 'x',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 5,
      sourceLengthSu: 1,
      ownershipTransfer: {
        ...ownershipTransfer,
        fragmentStartSu: 0,
        fragmentEndSu: 1
      }
    })
    expect(onData).toHaveBeenCalledTimes(1)

    handler('pty.data', {
      id: 'pty-1',
      data: 'bad',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 7,
      sourceLengthSu: 3,
      ownershipTransfer: { ...ownershipTransfer, fragmentEndSu: 4 }
    })
    expect(onData).toHaveBeenCalledTimes(1)
    expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', expect.anything())

    handler('pty.data', {
      id: 'pty-1',
      data: 'x',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      sourceEndSu: 5,
      sourceLengthSu: 1,
      ownershipTransfer: {
        ...ownershipTransfer,
        bridgeId: 'bridge-other',
        fragmentStartSu: 0,
        fragmentEndSu: 1,
        frameLengthSu: 1
      }
    })
    expect(onData).toHaveBeenCalledTimes(1)
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
