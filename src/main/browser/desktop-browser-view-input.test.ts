import type { WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DesktopBrowserViewInputSchema } from '../../shared/desktop-browser-view-input'

const release = vi.fn()
const acquire = vi.fn((..._args: unknown[]) => ({ release }))
const send = vi.fn()

vi.mock('./electron-debugger-lease', () => ({
  acquireElectronDebugger: (...args: unknown[]) => acquire(...args)
}))
vi.mock('./guest-cdp-command', () => ({
  sendGuestCdpCommand: (...args: unknown[]) => send(...args)
}))

import { dispatchDesktopBrowserViewInput } from './desktop-browser-view-input'

const viewport = (width = 400, height = 200) => ({
  cssVisualViewport: { clientWidth: width, clientHeight: height }
})

const guest = (destroyed = false): WebContents =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only reads isDestroyed from this test double.
  ({ isDestroyed: () => destroyed }) as unknown as WebContents

describe('desktop owned view input', () => {
  beforeEach(() => {
    acquire.mockClear()
    release.mockClear()
    send.mockReset()
    send.mockImplementation(async (_wc: unknown, method: string) =>
      method === 'Page.getLayoutMetrics' ? viewport() : {}
    )
  })

  it('rejects strict unknown fields and invalid normalized ratios', () => {
    expect(() =>
      DesktopBrowserViewInputSchema.parse({ kind: 'text', text: 'x', extra: true })
    ).toThrow()
    expect(() =>
      DesktopBrowserViewInputSchema.parse({
        kind: 'key',
        type: 'up',
        key: 'a',
        code: 'KeyA',
        text: 'a'
      })
    ).toThrow()
    expect(() =>
      DesktopBrowserViewInputSchema.parse({ kind: 'mouse', type: 'move', x: 2, y: 0 })
    ).toThrow()
  })

  it('rejects non-finite coordinates, wheel deltas, button bounds, and unknown mouse fields', () => {
    for (const input of [
      { kind: 'mouse', type: 'move', x: Number.NaN, y: 0 },
      { kind: 'mouse', type: 'move', x: Infinity, y: 0 },
      { kind: 'mouse', type: 'wheel', x: 0, y: 0, deltaX: Infinity, deltaY: 0 },
      { kind: 'mouse', type: 'down', x: 0, y: 0, buttons: 8 },
      { kind: 'mouse', type: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 0, button: 'left' },
      {
        kind: 'mouse',
        type: 'move',
        x: 0,
        y: 0,
        modifiers: ['Alt', 'Control', 'Meta', 'Shift', 'Alt']
      },
      { kind: 'key', type: 'down', key: 'x'.repeat(129), code: 'KeyX' },
      { kind: 'text', text: 'x'.repeat(65_537) }
    ]) {
      expect(() => DesktopBrowserViewInputSchema.parse(input)).toThrow()
    }
  })

  it('maps down and up events to CSS visual viewport pixels with click counts and buttons', async () => {
    send.mockImplementation(async (_wc: unknown, method: string) =>
      method === 'Page.getLayoutMetrics'
        ? {
            cssVisualViewport: { clientWidth: 375, clientHeight: 667, pageX: 900, pageY: 600 },
            cssLayoutViewport: { clientWidth: 1200, clientHeight: 900, pageX: 900, pageY: 600 }
          }
        : {}
    )

    await dispatchDesktopBrowserViewInput(guest(), {
      kind: 'mouse',
      type: 'down',
      x: 0.4,
      y: 0.3,
      button: 'left',
      buttons: 1,
      modifiers: ['Shift']
    })
    await dispatchDesktopBrowserViewInput(guest(), {
      kind: 'mouse',
      type: 'up',
      x: 0.4,
      y: 0.3,
      button: 'left',
      buttons: 0
    })

    expect(send).toHaveBeenNthCalledWith(2, expect.anything(), 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 150,
      y: 200.1,
      button: 'left',
      buttons: 1,
      modifiers: 8,
      clickCount: 1,
      deltaX: undefined,
      deltaY: undefined
    })
    expect(send).toHaveBeenNthCalledWith(4, expect.anything(), 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 150,
      y: 200.1,
      button: 'left',
      buttons: 0,
      modifiers: 0,
      clickCount: 1,
      deltaX: undefined,
      deltaY: undefined
    })
  })

  it('sends wheel deltas and modifiers in CSS visual viewport coordinates', async () => {
    await dispatchDesktopBrowserViewInput(guest(), {
      kind: 'mouse',
      type: 'wheel',
      x: 0.25,
      y: 0.5,
      deltaX: -12,
      deltaY: 24,
      buttons: 2,
      modifiers: ['Alt', 'Control']
    })

    expect(send).toHaveBeenNthCalledWith(2, expect.anything(), 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 100,
      y: 100,
      button: 'none',
      buttons: 2,
      modifiers: 3,
      clickCount: undefined,
      deltaX: -12,
      deltaY: 24
    })
  })

  it('uses resolved default text and virtual key codes for Enter and Tab keydown events', async () => {
    await dispatchDesktopBrowserViewInput(guest(), {
      kind: 'key',
      type: 'down',
      key: 'Enter',
      code: 'Enter'
    })
    await dispatchDesktopBrowserViewInput(guest(), {
      kind: 'key',
      type: 'down',
      key: 'Tab',
      code: 'Tab'
    })

    expect(send).toHaveBeenNthCalledWith(1, expect.anything(), 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
      modifiers: 0
    })
    expect(send).toHaveBeenNthCalledWith(2, expect.anything(), 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      text: '\t',
      modifiers: 0
    })
  })

  it('does not attach text to keyup or a Ctrl printable shortcut', async () => {
    await dispatchDesktopBrowserViewInput(guest(), {
      kind: 'key',
      type: 'up',
      key: 'a',
      code: 'KeyA'
    })
    await dispatchDesktopBrowserViewInput(guest(), {
      kind: 'key',
      type: 'down',
      key: 'a',
      code: 'KeyA',
      modifiers: ['Control']
    })

    expect(send).toHaveBeenNthCalledWith(1, expect.anything(), 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      text: undefined,
      modifiers: 0
    })
    expect(send).toHaveBeenNthCalledWith(2, expect.anything(), 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      text: undefined,
      modifiers: 2
    })
  })

  it('inserts text and committed composition without fetching layout metrics', async () => {
    await dispatchDesktopBrowserViewInput(guest(), { kind: 'text', text: 'plain text' })
    await dispatchDesktopBrowserViewInput(guest(), { kind: 'composition', text: '確定' })

    expect(send).toHaveBeenNthCalledWith(1, expect.anything(), 'Input.insertText', {
      text: 'plain text'
    })
    expect(send).toHaveBeenNthCalledWith(2, expect.anything(), 'Input.insertText', { text: '確定' })
    expect(send).not.toHaveBeenCalledWith(expect.anything(), 'Page.getLayoutMetrics')
  })

  it('rejects a destroyed tab before acquiring a debugger lease', async () => {
    await expect(
      dispatchDesktopBrowserViewInput(guest(true), { kind: 'text', text: 'x' })
    ).rejects.toThrow('Browser tab is no longer available')
    expect(acquire).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects invalid CSS visual viewport metrics and releases the lease', async () => {
    send.mockResolvedValueOnce({
      cssVisualViewport: { clientWidth: Number.NaN, clientHeight: Infinity }
    })

    await expect(
      dispatchDesktopBrowserViewInput(guest(), { kind: 'mouse', type: 'move', x: 0, y: 0 })
    ).rejects.toThrow('Browser CSS visual viewport is unavailable')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases the lease when mouse dispatch fails after layout succeeds', async () => {
    send.mockResolvedValueOnce(viewport()).mockRejectedValueOnce(new Error('dispatch failed'))

    await expect(
      dispatchDesktopBrowserViewInput(guest(), { kind: 'mouse', type: 'move', x: 0, y: 0 })
    ).rejects.toThrow('dispatch failed')
    expect(release).toHaveBeenCalledTimes(1)
  })
})
