import { describe, expect, it, vi } from 'vitest'
import { waitForRoute } from './browser-client-network-route-settlement'

describe('waitForRoute', () => {
  it('removes the abort listener when route work settles first', async () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    await expect(waitForRoute(Promise.resolve('ready'), controller.signal)).resolves.toBe('ready')

    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('rejects on abort while retaining no listener for the pending work', async () => {
    const controller = new AbortController()
    const work = new Promise<void>(() => {})
    const waiting = waitForRoute(work, controller.signal)

    controller.abort()

    await expect(waiting).rejects.toThrow('browser_client_network_route_aborted')
    expect(controller.signal.aborted).toBe(true)
  })
})
