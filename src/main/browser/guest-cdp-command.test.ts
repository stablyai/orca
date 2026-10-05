import { describe, expect, it, vi } from 'vitest'
import { BrowserError } from './browser-error'
import { browserCaptureIdle } from './browser-capture-idle'
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
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

  it('waits for an already admitted raw command before a reservation can move', async () => {
    const raw = deferred<{ ok: boolean }>()
    const { guest, sendCommand } = makeGuest()
    sendCommand.mockReturnValue(raw.promise)
    const command = sendGuestCdpCommand(guest, 'Emulation.setVisibleSize', { width: 2, height: 3 })
    const reservation = browserCaptureIdle.reserve(guest)

    expect(() => browserCaptureIdle.assertCaptureAllowed(guest)).toThrow('reserved')
    raw.resolve({ ok: true })
    await expect(command).resolves.toEqual({ ok: true })
    const lease = await reservation
    lease.release()
  })

  it('allows an exact reservation to issue a metric command without a nested reserve', async () => {
    const { guest, sendCommand } = makeGuest()
    const lease = await browserCaptureIdle.reserve(guest)

    await expect(
      sendGuestCdpCommand(guest, 'Emulation.setVisibleSize', { width: 2, height: 3 }, undefined, {
        reservation: lease
      })
    ).resolves.toEqual({ ok: true })
    expect(sendCommand).toHaveBeenCalledTimes(1)
    lease.release()
  })
})
