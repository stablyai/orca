import { describe, expect, it, vi } from 'vitest'
import { SshPtySourceDeliveryLedger } from './ssh-pty-source-delivery-ledger'

describe('SshPtySourceDeliveryLedger', () => {
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
})
