import { describe, expect, it, vi } from 'vitest'
import { BrowserError } from './browser-error'
import { sendGuestCdpCommand } from './guest-cdp-command'

function makeGuest(state: { crashed?: boolean; destroyed?: boolean } = {}) {
  const sendCommand = vi.fn(async () => ({ ok: true }))
  const guest = {
    isDestroyed: vi.fn(() => state.destroyed ?? false),
    isCrashed: vi.fn(() => {
      if (state.destroyed) {
        throw new Error('Object has been destroyed')
      }
      return state.crashed ?? false
    }),
    debugger: { sendCommand }
  }
  return { guest, sendCommand }
}

describe('sendGuestCdpCommand', () => {
  it.each(['Emulation.setDeviceMetricsOverride', 'Emulation.setVisibleSize'])(
    'refuses %s while the renderer is gone instead of letting Chromium crash the app',
    async (method) => {
      const { guest, sendCommand } = makeGuest({ crashed: true })
      const sent = sendGuestCdpCommand(guest, method, { width: 375, height: 667 })
      await expect(sent).rejects.toBeInstanceOf(BrowserError)
      await expect(sent).rejects.toMatchObject({ code: 'browser_cdp_error' })
      expect(sendCommand).not.toHaveBeenCalled()
    }
  )

  it('refuses a resize on a destroyed guest without asking it whether it crashed', async () => {
    const { guest, sendCommand } = makeGuest({ destroyed: true })
    await expect(
      sendGuestCdpCommand(guest, 'Emulation.setDeviceMetricsOverride', { width: 1, height: 1 })
    ).rejects.toBeInstanceOf(BrowserError)
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('still sends commands that do not resize the view to a crashed guest', async () => {
    const { guest, sendCommand } = makeGuest({ crashed: true })
    await expect(
      sendGuestCdpCommand(guest, 'Emulation.setUserAgentOverride', { userAgent: 'x' })
    ).resolves.toEqual({ ok: true })
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', { userAgent: 'x' })
  })

  it('sends a resize to a live guest, and passes a session id only when one is given', async () => {
    const { guest, sendCommand } = makeGuest()
    await sendGuestCdpCommand(guest, 'Emulation.setVisibleSize', { width: 2, height: 3 })
    await sendGuestCdpCommand(guest, 'DOM.enable', {}, 'iframe-session')
    expect(sendCommand.mock.calls).toEqual([
      ['Emulation.setVisibleSize', { width: 2, height: 3 }],
      ['DOM.enable', {}, 'iframe-session']
    ])
  })
})
