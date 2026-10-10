import { describe, expect, it, vi } from 'vitest'
import { waitForSshCapabilityProbe } from './ssh-capability-probe-waiter'

describe('waitForSshCapabilityProbe', () => {
  it('removes the caller abort listener when a probe is cancelled', async () => {
    let resolveProbe!: (value: boolean) => void
    const probe = new Promise<boolean>((resolve) => {
      resolveProbe = resolve
    })
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const waiting = waitForSshCapabilityProbe(probe, controller.signal)

    controller.abort()

    await expect(waiting).rejects.toThrow('client_disconnected')
    expect(removeListener).toHaveBeenCalledTimes(1)
    resolveProbe(true)
  })

  it('keeps probe results when the caller remains connected', async () => {
    const controller = new AbortController()
    await expect(waitForSshCapabilityProbe(Promise.resolve(true), controller.signal)).resolves.toBe(
      true
    )
  })
})
