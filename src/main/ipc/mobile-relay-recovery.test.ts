import { describe, expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  shell: { openExternal: vi.fn() }
}))

import { registerMobileHandlers } from './mobile'

describe('mobile Relay recovery', () => {
  it('recovers Relay before automatic pairing, including Retry, but never for LAN', async () => {
    const events: string[] = []
    const onBeforeRelayPairing = vi.fn(() => {
      events.push('recover')
    })
    const createMobilePairingOffer = vi.fn(async () => {
      events.push('pair')
      return { available: false, reason: 'relay_mint_failed' }
    })
    registerMobileHandlers({ createMobilePairingOffer } as never, { onBeforeRelayPairing })
    const request = handlers.get('mobile:getPairingQR')!
    await request({}, { address: '127.0.0.1' })
    await request({}, { address: '127.0.0.1', connectionMode: 'automatic', rotate: true })
    await request({}, { address: '127.0.0.1', connectionMode: 'local-only' })
    expect(events).toEqual(['recover', 'pair', 'recover', 'pair', 'pair'])
    expect(onBeforeRelayPairing).toHaveBeenCalledTimes(2)
  })
})
