import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { setupGuestShortcutForwarding } from './browser-guest-shortcut-forwarding'

/** Captures ownership and shortcut messages together so tests can verify their ordering. */
function createHarness() {
  const events = new EventEmitter()
  const send = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this binding only subscribes to these WebContents events.
  const guest = events as unknown as Electron.WebContents
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwarding only calls the renderer's send method.
  const renderer = { send } as unknown as Electron.WebContents
  const resolveRenderer = vi.fn((): Electron.WebContents | null => renderer)
  const cleanup = setupGuestShortcutForwarding({ browserTabId: 'page-a', guest, resolveRenderer })
  return { events, send, cleanup, resolveRenderer }
}

describe('browser guest interaction ownership', () => {
  it('reports mouse presses but not moves, scrolling, or releases', () => {
    const { events, send } = createHarness()
    const event = { preventDefault: vi.fn() }
    for (const type of ['mouseMove', 'mouseWheel', 'mouseUp', 'mouseLeave']) {
      events.emit('before-mouse-event', event, { type })
    }
    expect(send).not.toHaveBeenCalled()
    events.emit('before-mouse-event', event, { type: 'mouseDown', button: 'left' })
    expect(send.mock.calls).toEqual([['ui:browserGuestInteraction', 'page-a']])
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('sends the source before Ctrl+Tab and preserves its release', () => {
    const { events, send } = createHarness()
    const event = { preventDefault: vi.fn() }
    events.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      control: true,
      meta: false
    })
    events.emit('before-input-event', event, {
      type: 'keyUp',
      key: 'Control',
      code: 'ControlLeft',
      control: false,
      meta: false
    })
    expect(send.mock.calls).toEqual([
      ['ui:browserGuestInteraction', 'page-a'],
      ['ui:ctrlTabKeyDown', { shiftKey: false }],
      ['ui:ctrlTabKeyUp']
    ])
  })

  it('does not treat programmatic guest focus or blur as user interaction', () => {
    const { events, send } = createHarness()
    events.emit('focus')
    events.emit('blur')
    expect(send).not.toHaveBeenCalled()
  })

  it('drops events after renderer ownership disappears and removes listeners on cleanup', () => {
    const { events, send, cleanup, resolveRenderer } = createHarness()
    resolveRenderer.mockReturnValue(null)
    events.emit('before-mouse-event', {}, { type: 'mouseDown' })
    expect(send).not.toHaveBeenCalled()
    cleanup()
    expect(events.listenerCount('before-mouse-event')).toBe(0)
    expect(events.listenerCount('before-input-event')).toBe(0)
  })
})
