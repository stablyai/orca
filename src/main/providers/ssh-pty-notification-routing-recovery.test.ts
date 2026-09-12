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
    resolvePtyIncarnation,
    peekPtyIncarnation: () => undefined
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

describe('SSH PTY notification recovery routing', () => {
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
