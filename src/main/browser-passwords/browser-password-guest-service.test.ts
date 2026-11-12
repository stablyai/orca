import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_PASSWORDS_GUEST_CHANNELS as channels } from '../../shared/browser-passwords-types'

const { handlers, renderer, injecting } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  renderer: { send: vi.fn(), focus: vi.fn(), isDestroyed: () => false },
  injecting: vi.fn(() => false)
}))
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => void) => handlers.set(channel, handler)
  }
}))
vi.mock('../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserManager: {
    getRendererContextForGuest: () => ({ browserPageId: 'page', renderer }),
    getGuestWebContentsId: () => 411
  }
}))
vi.mock('../browser/cdp/input/agent-input-injection', () => ({ isAgentInjectingInput: injecting }))
vi.mock('./browser-password-reauth', () => ({ confirmBrowserPasswordFill: vi.fn() }))
vi.mock('./browser-password-save-prompts', () => ({
  BROWSER_PASSWORDS_RENDERER_EVENTS: {
    fieldFocus: 'browserPasswords:fieldFocus',
    fieldBlur: 'browserPasswords:fieldBlur'
  },
  closeBrowserPasswordSavePromptsForGuest: vi.fn(),
  offerBrowserPasswordSave: vi.fn()
}))
vi.mock('./browser-password-vault-access', () => ({
  setBrowserPasswordSettingsSource: vi.fn(),
  browserPasswordVaultForGuest: () => ({
    vault: {
      findForOrigin: () => ({
        ok: true,
        value: {
          exact: [{ id: 'entry', origin: 'https://example.com', username: 'ada' }],
          sameSite: []
        }
      }),
      getPassword: () => ({ ok: true, value: 'secret' })
    }
  })
}))
import { confirmBrowserPasswordFill } from './browser-password-reauth'
import {
  attachBrowserPasswordGuest,
  configureBrowserPasswords,
  fillBrowserPassword
} from './browser-password-guest-service'

function frame(origin: string) {
  return { origin, send: vi.fn(), isDestroyed: () => false, detached: false }
}

class Guest extends EventEmitter {
  id = 411
  mainFrame = frame('https://example.com')
  send = vi.fn()
  isDestroyed = () => false
}
const guests: Guest[] = []
afterEach(() => {
  for (const guest of guests) {
    guest.emit('destroyed')
  }
  guests.length = 0
  renderer.send.mockClear()
  renderer.focus.mockClear()
  injecting.mockReset().mockReturnValue(false)
})

function setup() {
  configureBrowserPasswords(() => ({ offerToSave: true, fillRequiresReauth: false }))
  const guest = new Guest()
  guests.push(guest)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the WebContents methods implemented by this event fixture are used.
  attachBrowserPasswordGuest(guest as unknown as Electron.WebContents)
  const event = { sender: guest, senderFrame: guest.mainFrame }
  handlers.get(channels.fieldFocused)?.(event, {
    fieldToken: 'field',
    formSignature: 'form',
    role: 'password',
    rect: { x: 0, y: 0, width: 100, height: 20 },
    viewportWidth: 1000
  })
  renderer.send.mockClear()
  return { guest, event }
}

describe('fill after Touch ID', () => {
  it('refuses to send the password when the page navigated while the prompt was up', async () => {
    const { guest } = setup()
    const matched = guest.mainFrame
    vi.mocked(confirmBrowserPasswordFill).mockImplementationOnce(async () => {
      guest.mainFrame = frame('https://evil.test')
      return true
    })

    const outcome = await fillBrowserPassword({
      browserPageId: 'page',
      fieldToken: 'field',
      entryId: 'entry'
    })

    expect(outcome).toEqual({ ok: false, reason: 'unavailable' })
    expect(matched.send).not.toHaveBeenCalled()
    expect(guest.mainFrame.send).not.toHaveBeenCalled()
  })
})
