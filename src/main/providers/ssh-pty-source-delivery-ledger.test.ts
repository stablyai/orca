import { describe, expect, it, vi } from 'vitest'
import { SshPtySourceDeliveryLedger } from './ssh-pty-source-delivery-ledger'

describe('SshPtySourceDeliveryLedger', () => {
  const activation = (deliveryToken: string) =>
    Object.freeze({
      status: 'pending' as const,
      clientGeneration: 2,
      ownerGeneration: 3,
      ptyIncarnation: 'incarnation-1',
      deliveryToken,
      checkpointSourceEndSu: 0,
      recoveryEndSu: 0
    })

  it('retains cancellation ownership when recovery transfer is superseded', async () => {
    const request = vi.fn(async () => ({ canceled: true, sentEndSu: 0, creditedEndSu: 0 }))
    const ledger = new SshPtySourceDeliveryLedger({ request } as never, vi.fn())
    const older = ledger.install(
      'pty-1',
      Object.freeze({
        status: 'pending',
        clientGeneration: 2,
        ownerGeneration: 3,
        ptyIncarnation: 'incarnation-1',
        deliveryToken: 'token-old',
        checkpointSourceEndSu: 0,
        recoveryEndSu: 0
      })
    )
    ledger.install(
      'pty-1',
      Object.freeze({
        status: 'pending',
        clientGeneration: 3,
        ownerGeneration: 4,
        ptyIncarnation: 'incarnation-1',
        deliveryToken: 'token-new',
        checkpointSourceEndSu: 0,
        recoveryEndSu: 0
      })
    )

    expect(() => older.transferToRecovery(vi.fn())).toThrow('ssh_source_receiving_activation_stale')
    await expect(older.rollback()).resolves.toBe(true)

    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('pty.cancelDelivery', {
      id: 'pty-1',
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token-old'
    })
  })

  it('retires an exact rejected activation only after cancellation is proven', async () => {
    const request = vi.fn(async () => ({ canceled: true, sentEndSu: 4, creditedEndSu: 0 }))
    const ledger = new SshPtySourceDeliveryLedger({ request } as never, vi.fn())
    ledger.install('pty-1', activation('token-old')).commit()

    await expect(ledger.reject('pty-1', activation('token-old'))).resolves.toBe('fresh-activation')

    expect(() => ledger.install('pty-1', activation('token-new')).commit()).not.toThrow()
  })

  it('keeps the current activation when a stale rejected token cannot cancel it', async () => {
    const publish = vi.fn()
    const request = vi.fn(async () => {
      throw new Error('Unknown or stale PTY source delivery cancellation')
    })
    const ledger = new SshPtySourceDeliveryLedger({ request } as never, publish)
    ledger.install('pty-1', activation('token-current')).commit()

    await expect(ledger.reject('pty-1', activation('token-stale'))).resolves.toBe(
      'confirm-existing'
    )
    expect(
      ledger.admit({
        relayPtyId: 'pty-1',
        params: { ptyIncarnation: 'incarnation-1' },
        data: 'healthy',
        source: {
          relayPtyId: 'pty-1',
          spanId: 'span-1',
          clientGeneration: 2,
          ownerGeneration: 3,
          deliveryToken: 'token-current',
          sourceStartSu: 0,
          sourceEndSu: 7
        }
      })
    ).toBe(true)
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ data: 'healthy' }))
  })
})
