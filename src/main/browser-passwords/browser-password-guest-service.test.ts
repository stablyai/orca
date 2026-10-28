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
vi.mock('../browser/browser-manager', () => ({
  browserManager: { getRendererContextForGuest: () => ({ browserPageId: 'page', renderer }) }
}))
vi.mock('../browser/agent-input-injection', () => ({ isAgentInjectingInput: injecting }))
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
      })
    }
  })
}))
import {
  attachBrowserPasswordGuest,
  configureBrowserPasswords
} from './browser-password-guest-service'

class Guest extends EventEmitter {
  id = 411
  mainFrame = { origin: 'https://example.com' }
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
  configureBrowserPasswords(() => ({ enabled: true, offerToSave: true, fillRequiresReauth: false }))
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

describe('native password picker keyboard handoff', () => {
  it('preserves the field during focus transfer, then invalidates it on navigation', () => {
    const { guest, event } = setup()
    const preventDefault = vi.fn()
    guest.emit('before-input-event', { preventDefault }, { type: 'keyDown', key: 'ArrowDown' })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(renderer.focus).toHaveBeenCalledOnce()
    expect(renderer.send).toHaveBeenCalledWith(
      'browserPasswords:fieldFocus',
      expect.objectContaining({ fieldToken: 'field', keyboardSelection: true })
    )
    renderer.send.mockClear()
    handlers.get(channels.fieldBlurred)?.(event, { fieldToken: 'field', reason: 'focusout' })
    expect(renderer.send).not.toHaveBeenCalled()
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, initiator: {} })
    expect(renderer.send).toHaveBeenCalledWith('browserPasswords:fieldBlur', {
      browserPageId: 'page',
      fieldToken: 'field'
    })
  })

  it('still dismisses on viewport invalidation if no focusout accompanied the transfer', () => {
    const { guest, event } = setup()
    guest.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      { type: 'keyDown', key: 'ArrowDown' }
    )
    renderer.send.mockClear()
    handlers.get(channels.fieldBlurred)?.(event, { fieldToken: 'field' })
    expect(renderer.send).toHaveBeenCalledWith('browserPasswords:fieldBlur', {
      browserPageId: 'page',
      fieldToken: 'field'
    })
  })

  it.each(['agent', 'modified'] as const)('does not enter the picker for %s input', (source) => {
    const { guest } = setup()
    injecting.mockReturnValue(source === 'agent')
    const preventDefault = vi.fn()
    guest.emit(
      'before-input-event',
      { preventDefault },
      { type: 'keyDown', key: 'ArrowDown', control: source === 'modified' }
    )
    expect(preventDefault).not.toHaveBeenCalled()
    expect(renderer.focus).not.toHaveBeenCalled()
    expect(renderer.send).not.toHaveBeenCalled()
  })
})
