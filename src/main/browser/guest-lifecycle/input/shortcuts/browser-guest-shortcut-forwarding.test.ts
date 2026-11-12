import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { setupGuestShortcutForwarding } from './browser-guest-shortcut-forwarding'

vi.mock('../../../cdp/input/agent-input-injection', () => ({ isAgentInjectingInput: () => false }))

it('forwards a modifier double tap without arming it during composition', () => {
  const guest = new EventEmitter()
  const send = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarding uses only the guest event emitter.
  const webContents = guest as unknown as Electron.WebContents
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarding uses only send on this renderer.
  const renderer = { send } as unknown as Electron.WebContents
  setupGuestShortcutForwarding({
    browserTabId: 'page',
    guest: webContents,
    resolveRenderer: () => renderer,
    isLocalRenderer: () => true,
    getKeybindings: () => ({ 'view.plugins': ['DoubleTap+Shift'] })
  })
  const event = { preventDefault: vi.fn() }
  const shift = { key: 'Shift', code: 'ShiftLeft', shift: true }
  guest.emit('before-input-event', event, { ...shift, type: 'keyDown', isComposing: true })
  guest.emit('before-input-event', event, { ...shift, type: 'keyUp', isComposing: true })
  guest.emit('before-input-event', event, { ...shift, type: 'keyDown' })
  expect(send).not.toHaveBeenCalled()
  guest.emit('before-input-event', event, { ...shift, type: 'keyUp' })
  guest.emit('before-input-event', event, { ...shift, type: 'keyDown' })
  expect(send).toHaveBeenCalledWith(
    'ui:browserPageTabShortcut',
    expect.objectContaining({ doubleTapModifier: 'Shift' })
  )
})
