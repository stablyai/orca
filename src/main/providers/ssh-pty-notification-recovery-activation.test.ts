import { describe, expect, it, vi } from 'vitest'
import { createSubscription, sourceActivation } from './ssh-pty-notification-routing-test-fixture'

describe('subscribeSshPtyNotifications', () => {
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
})
