import { describe, expect, it, vi } from 'vitest'
import type { PtySourceReceivingActivation } from '../../shared/pty-source-receiving-activation'
import { SshPtyProviderOutputState } from './ssh-pty-provider-output-state'

function activation(): PtySourceReceivingActivation {
  return {
    status: 'pending',
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: 'incarnation-1',
    deliveryToken: 'token-1',
    checkpointSourceEndSu: 0,
    recoveryEndSu: 0
  }
}

describe('SshPtyProviderOutputState ownership-transfer routing', () => {
  it('assembles source fragments before invoking the destination sink', () => {
    let notificationHandler: ((method: string, params: Record<string, unknown>) => void) | undefined
    const onNotification = vi.fn(
      (callback: (method: string, params: Record<string, unknown>) => void) => {
        notificationHandler = callback
        return vi.fn()
      }
    )
    const mux = {
      onNotification,
      request: vi.fn(async () => ({ canceled: true, sentEndSu: 0, creditedEndSu: 0 }))
    }
    const delivered = vi.fn()
    const outputState = new SshPtyProviderOutputState(7, {
      mux: mux as never,
      toAppPtyId: (id) => `ssh:conn@@${id}`,
      livePtyIds: new Set(),
      recordExit: vi.fn(),
      onOwnershipTransferOutput: delivered
    })
    const handler = notificationHandler
    if (!handler) {
      throw new Error('notification handler was not installed')
    }
    outputState.installReceivingActivation('pty-1', activation()).commit()

    const envelope = {
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
    const base = {
      id: 'pty-1',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3
    }
    handler('pty.data', {
      ...base,
      data: 'ab',
      sourceEndSu: 2,
      sourceLengthSu: 2,
      ownershipTransfer: { ...envelope, fragmentStartSu: 0, fragmentEndSu: 2 }
    })
    expect(delivered).not.toHaveBeenCalled()
    handler('pty.data', {
      ...base,
      data: 'cd',
      sourceEndSu: 4,
      sourceLengthSu: 2,
      ownershipTransfer: { ...envelope, fragmentStartSu: 2, fragmentEndSu: 4 }
    })

    expect(delivered).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeId: 'bridge-1' }),
      { seq: 1, data: 'abcd' },
      expect.arrayContaining([
        expect.objectContaining({ spanId: 'token-1:0:2' }),
        expect.objectContaining({ spanId: 'token-1:2:4' })
      ])
    )
    outputState.dispose()
  })

  it('publishes normal intake before an asynchronous destination callback completes', async () => {
    let notificationHandler: ((method: string, params: Record<string, unknown>) => void) | undefined
    const onNotification = vi.fn(
      (callback: (method: string, params: Record<string, unknown>) => void) => {
        notificationHandler = callback
        return vi.fn()
      }
    )
    const mux = {
      onNotification,
      request: vi.fn(async () => ({ canceled: true, sentEndSu: 0, creditedEndSu: 0 }))
    }
    const events: string[] = []
    let releaseDestination!: () => void
    const destinationDone = new Promise<void>((resolve) => {
      releaseDestination = resolve
    })
    const outputState = new SshPtyProviderOutputState(7, {
      mux: mux as never,
      toAppPtyId: (id) => `ssh:conn@@${id}`,
      livePtyIds: new Set(),
      recordExit: vi.fn(),
      onOwnershipTransferOutput: async () => {
        events.push('destination:start')
        await destinationDone
        events.push('destination:done')
      }
    })
    const handler = notificationHandler
    if (!handler) {
      throw new Error('notification handler was not installed')
    }
    outputState.onData((payload) => events.push(`normal:${payload.data}`))
    outputState.installReceivingActivation('pty-1', activation()).commit()

    const envelope = {
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
    const base = {
      id: 'pty-1',
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      clientGeneration: 2,
      ownerGeneration: 3
    }
    handler('pty.data', {
      ...base,
      data: 'ab',
      sourceEndSu: 2,
      sourceLengthSu: 2,
      ownershipTransfer: { ...envelope, fragmentStartSu: 0, fragmentEndSu: 2 }
    })
    handler('pty.data', {
      ...base,
      data: 'cd',
      sourceEndSu: 4,
      sourceLengthSu: 2,
      ownershipTransfer: { ...envelope, fragmentStartSu: 2, fragmentEndSu: 4 }
    })

    expect(events).toEqual(['normal:ab', 'destination:start', 'normal:cd'])
    releaseDestination()
    await destinationDone
    await Promise.resolve()
    expect(events).toEqual(['normal:ab', 'destination:start', 'normal:cd', 'destination:done'])
    outputState.dispose()
  })
})
