import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  dispatchPageKeyEvent,
  planCdpKeyEvent,
  planInsertText,
  routePageTextInsertion,
  type GuestCdpSender
} from './guest-direct-key-input'

function fakePage(type: string) {
  const page = {
    getType: vi.fn(() => type),
    focus: vi.fn(),
    sendInputEvent: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    isDestroyed: vi.fn(() => false),
    selectAll: vi.fn(),
    copy: vi.fn(),
    cut: vi.fn(),
    paste: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    delete: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member these functions call.
  return { page, webContents: page as unknown as WebContents }
}

function fakeSender() {
  return vi.fn<GuestCdpSender>(async (method) =>
    method === 'Runtime.evaluate' ? { result: { type: 'object', subtype: 'null' } } : {}
  )
}

// Why: the root document's focus is on a cross-site frame (target F1); inside it, on a field.
function crossSiteFrameSender(options: { attachable: boolean }) {
  return vi.fn<GuestCdpSender>(async (method, _params, sessionId) => {
    switch (method) {
      case 'Runtime.evaluate':
        return sessionId
          ? { result: { type: 'object', subtype: 'null' } }
          : { result: { objectId: 'frame-element' } }
      case 'DOM.describeNode':
        return { node: { frameId: 'F1' } }
      case 'Target.getTargets':
        return { targetInfos: [{ targetId: 'F1', type: 'iframe' }] }
      case 'Target.attachToTarget':
        if (!options.attachable) {
          throw new Error('No target with given id')
        }
        return { sessionId: 'S1' }
      default:
        return {}
    }
  })
}

describe('planCdpKeyEvent', () => {
  it('types a printable keyDown as a key event plus its character', () => {
    expect(planCdpKeyEvent({ type: 'keyDown', key: 'a', text: 'a', modifiers: 0 })).toEqual({
      events: [
        { type: 'keyDown', keyCode: 'a', modifiers: [], skipIfUnhandled: true },
        { type: 'char', keyCode: 'a', modifiers: [], skipIfUnhandled: true }
      ],
      commands: []
    })
  })

  it('maps named keys and modifier masks to Electron names', () => {
    expect(planCdpKeyEvent({ type: 'rawKeyDown', key: 'ArrowUp', modifiers: 1 | 8 })).toEqual({
      events: [
        { type: 'keyDown', keyCode: 'Up', modifiers: ['alt', 'shift'], skipIfUnhandled: true }
      ],
      commands: []
    })
    expect(planCdpKeyEvent({ type: 'keyUp', key: 'F5', modifiers: 2 | 4 })?.events).toEqual([
      { type: 'keyUp', keyCode: 'F5', modifiers: ['control', 'meta'], skipIfUnhandled: true }
    ])
  })

  it('sends Enter with its carriage-return char so forms submit', () => {
    expect(planCdpKeyEvent({ type: 'keyDown', key: 'Enter', text: '\r' })?.events).toEqual([
      { type: 'keyDown', keyCode: 'Enter', modifiers: [], skipIfUnhandled: true },
      { type: 'char', keyCode: '\r', modifiers: [], skipIfUnhandled: true }
    ])
  })

  it('accepts Enter with a newline as its text', () => {
    expect(planCdpKeyEvent({ type: 'keyDown', key: 'Enter', text: '\n' })?.events).toHaveLength(2)
  })

  it('drops the control-character text of other named keys', () => {
    expect(planCdpKeyEvent({ type: 'keyDown', key: 'Tab', text: '\t' })?.events).toEqual([
      { type: 'keyDown', keyCode: 'Tab', modifiers: [], skipIfUnhandled: true }
    ])
  })

  it('types a character outside the US layout with its char event alone', () => {
    expect(planCdpKeyEvent({ type: 'keyDown', key: 'é', text: 'é' })?.events).toEqual([
      { type: 'char', keyCode: 'é', modifiers: [], skipIfUnhandled: true }
    ])
  })

  it('carries supported editing commands', () => {
    expect(
      planCdpKeyEvent({ type: 'rawKeyDown', key: 'a', modifiers: 4, commands: ['selectAll'] })
        ?.commands
    ).toEqual(['selectAll'])
  })

  it('declines what widget events cannot express', () => {
    expect(planCdpKeyEvent({ type: 'rawKeyDown', key: 'a', commands: ['moveToEndOfLine'] })).toBe(
      null
    )
    expect(planCdpKeyEvent({ type: 'rawKeyDown', key: 'Unidentified' })).toBe(null)
    expect(planCdpKeyEvent({ type: 'char', text: '' })).toBe(null)
    expect(planCdpKeyEvent({ type: 'keyDown', key: 'a', text: '\u0001' })).toBe(null)
    expect(planCdpKeyEvent({ type: 'mousePressed' })).toBe(null)
  })
})

describe('planInsertText', () => {
  it('types each code point, including astral ones, as a char event', () => {
    expect(planInsertText('a😀')?.map((event) => event.keyCode)).toEqual(['a', '😀'])
  })

  it('declines text with control characters, which char events drop', () => {
    expect(planInsertText('a\nb')).toBe(null)
    expect(planInsertText('')).toBe(null)
  })
})

describe('dispatchPageKeyEvent', () => {
  it('sends an embedded guest widget events without focusing it or using CDP input', async () => {
    const { page, webContents } = fakePage('webview')
    const send = fakeSender()

    await expect(
      dispatchPageKeyEvent(webContents, { type: 'keyDown', key: 'z', text: 'z' }, send)
    ).resolves.toEqual({})

    expect(page.focus).not.toHaveBeenCalled()
    expect(page.sendInputEvent).toHaveBeenCalledTimes(2)
    // Why: the focus probe, then the round trip that waits for the page to handle the key.
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'Runtime.evaluate',
      'Runtime.evaluate'
    ])
  })

  it('releases a non-US character without focusing the guest', async () => {
    const { page, webContents } = fakePage('webview')
    const send = fakeSender()

    await dispatchPageKeyEvent(webContents, { type: 'keyUp', key: 'é' }, send)

    expect(page.focus).not.toHaveBeenCalled()
    expect(page.sendInputEvent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.anything())
  })

  it('treats a failed focus probe as main-frame focus instead of failing the key', async () => {
    const { page, webContents } = fakePage('webview')
    const send = vi.fn<GuestCdpSender>(async () => {
      throw new Error('Execution context was destroyed')
    })

    await expect(
      dispatchPageKeyEvent(webContents, { type: 'keyDown', key: 'z', text: 'z' }, send)
    ).resolves.toEqual({})

    expect(page.focus).not.toHaveBeenCalled()
    expect(page.sendInputEvent).toHaveBeenCalledTimes(2)
  })

  it('guards the user’s focus for Tab, which can leave the page for Orca’s window', async () => {
    const { page, webContents } = fakePage('webview')
    const release = vi.fn()
    const guardFocus = vi.fn(async () => release)

    await dispatchPageKeyEvent(
      webContents,
      { type: 'rawKeyDown', key: 'Tab' },
      fakeSender(),
      guardFocus
    )
    await dispatchPageKeyEvent(
      webContents,
      { type: 'keyDown', key: 'a', text: 'a' },
      fakeSender(),
      guardFocus
    )

    expect(guardFocus).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(page.focus).not.toHaveBeenCalled()
  })

  it('does not send Tab when the user’s focus cannot be guarded', async () => {
    const { page, webContents } = fakePage('webview')

    await expect(
      dispatchPageKeyEvent(
        webContents,
        { type: 'rawKeyDown', key: 'Tab' },
        fakeSender(),
        async () => {
          throw new Error('unavailable')
        }
      )
    ).rejects.toThrow('unavailable')

    expect(page.sendInputEvent).not.toHaveBeenCalled()
  })

  it('runs editing commands on the guest', async () => {
    const { page, webContents } = fakePage('webview')

    await dispatchPageKeyEvent(
      webContents,
      { type: 'rawKeyDown', key: 'a', modifiers: 4, commands: ['selectAll'] },
      fakeSender()
    )

    expect(page.selectAll).toHaveBeenCalledTimes(1)
  })

  it('types into a focused cross-site frame on its own session, without focusing the guest', async () => {
    const { page, webContents } = fakePage('webview')
    const send = crossSiteFrameSender({ attachable: true })
    const params = { type: 'keyDown', key: 'z', text: 'z' }

    await dispatchPageKeyEvent(webContents, params, send, async () => () => {})

    expect(page.focus).not.toHaveBeenCalled()
    expect(page.sendInputEvent).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('Emulation.setFocusEmulationEnabled', { enabled: true }, 'S1')
    expect(send).toHaveBeenLastCalledWith('Input.dispatchKeyEvent', params, 'S1')
  })

  it('borrows focus for CDP when the focused frame cannot be reached, then gives it back', async () => {
    const { page, webContents } = fakePage('webview')
    const send = crossSiteFrameSender({ attachable: false })
    const release = vi.fn()
    const params = { type: 'keyDown', key: 'z', text: 'z' }

    await dispatchPageKeyEvent(webContents, params, send, async () => release)

    expect(page.sendInputEvent).not.toHaveBeenCalled()
    expect(page.focus).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith('Input.dispatchKeyEvent', params)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('keeps CDP input for pages outside an Orca window', async () => {
    const { page, webContents } = fakePage('window')
    const send = fakeSender()
    const params = { type: 'keyDown', key: 'z', text: 'z' }

    await dispatchPageKeyEvent(webContents, params, send)

    expect(page.focus).not.toHaveBeenCalled()
    expect(page.sendInputEvent).not.toHaveBeenCalled()
    expect(send.mock.calls).toEqual([['Input.dispatchKeyEvent', params]])
  })
})

describe('routePageTextInsertion', () => {
  it('types into an embedded guest without focusing it', async () => {
    const { page, webContents } = fakePage('webview')
    const send = fakeSender()

    const route = await routePageTextInsertion(webContents, { text: 'hi' }, send)
    await route.deliver({ text: 'hi' })

    expect(page.focus).not.toHaveBeenCalled()
    expect(page.sendInputEvent.mock.calls.map(([event]) => event.keyCode)).toEqual(['h', 'i'])
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'Runtime.evaluate',
      'Runtime.evaluate'
    ])
  })

  it('borrows focus to deliver over CDP when text cannot be typed', async () => {
    const { page, webContents } = fakePage('webview')
    const send = fakeSender()
    const release = vi.fn()
    const guardFocus = vi.fn(async () => release)

    const route = await routePageTextInsertion(webContents, { text: 'a\nb' }, send, guardFocus)
    expect(page.focus).toHaveBeenCalledTimes(1)
    await route.deliver({ text: 'a\nb' })

    // Why: the caller releases, so an insert abandoned before delivery still gives focus back.
    expect(route.release).toBe(release)
    expect(page.sendInputEvent).not.toHaveBeenCalled()
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'Runtime.evaluate',
      'Emulation.setFocusEmulationEnabled',
      'Input.insertText'
    ])
  })
})

describe('routePageTextInsertion into a cross-site frame', () => {
  it('delivers any text, newlines included, on the frame’s session', async () => {
    const { page, webContents } = fakePage('webview')
    const send = crossSiteFrameSender({ attachable: true })

    const route = await routePageTextInsertion(webContents, { text: 'a\nb' }, send)
    await route.deliver({ text: 'a\nb' })

    expect(page.focus).not.toHaveBeenCalled()
    expect(send).toHaveBeenLastCalledWith('Input.insertText', { text: 'a\nb' }, 'S1')
  })
})
