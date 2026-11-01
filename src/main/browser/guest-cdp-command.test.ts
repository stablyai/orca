import { describe, expect, it, vi } from 'vitest'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { runInRemoteCliBrowserScope } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'

function makeGuest(state: { crashed?: boolean; destroyed?: boolean } = {}) {
  const sendCommand = vi.fn(async () => ({ ok: true }))
  const guest = {
    id: 3,
    setIgnoreMenuShortcuts: vi.fn(),
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
  it('refuses a host the answer to a read that landed after its page moved to a desktop file', async () => {
    let url = 'https://example.com/'
    const { guest, sendCommand } = makeGuest()
    sendCommand.mockImplementation(async () => {
      url = 'file:///Users/me/private.txt'
      return { ok: true }
    })
    const sent = runInRemoteCliBrowserScope(
      'wt-1',
      () => sendGuestCdpCommand({ ...guest, id: 7 }, 'DOM.getDocument', {}),
      undefined,
      () => url.startsWith('https:')
    )
    await expect(sent).rejects.toMatchObject({ code: 'desktop_browser_bridge_unrouted' })
    expect(sendCommand).toHaveBeenCalledTimes(1)
  })

  it('keeps a host input that landed even when the host is revoked before it answers', async () => {
    const revoked = new AbortController()
    const { guest, sendCommand } = makeGuest()
    sendCommand.mockImplementation(async () => {
      revoked.abort()
      return { ok: true }
    })
    const sent = runInRemoteCliBrowserScope(
      'wt-1',
      () =>
        sendGuestCdpCommand({ ...guest, id: 7 }, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'a'
        }),
      revoked.signal
    )
    await expect(sent).resolves.toEqual({ ok: true })
  })
})
