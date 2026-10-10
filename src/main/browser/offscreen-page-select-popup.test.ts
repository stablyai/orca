import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { OffscreenPageUserInput } from '../../shared/offscreen-page-protocol'

const { buildFromTemplate, popup } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  popup: vi.fn()
}))

vi.mock('electron', () => ({ Menu: { buildFromTemplate } }))

import {
  mayOpenOffscreenPageSelect,
  readOpenOffscreenPageSelect,
  showOffscreenPageSelectMenu,
  toHostSelectAnchor,
  type OffscreenPageSelectPopup
} from './offscreen-page-select-popup'

const openSelect: OffscreenPageSelectPopup = {
  items: [
    { label: 'alpha', index: 0, disabled: false },
    { label: 'Group', index: null, disabled: true },
    { label: 'beta', index: 1, disabled: false },
    { label: 'gamma', index: 2, disabled: true }
  ],
  selectedIndex: 1,
  anchor: { x: 100, y: 200, width: 80, height: 20 }
}

function fakeContents(isolatedResult: unknown = null) {
  return {
    isDestroyed: () => false,
    getZoomFactor: () => 1.2,
    sendInputEvent: vi.fn(),
    executeJavaScriptInIsolatedWorld: vi.fn(() => Promise.resolve(isolatedResult))
  }
}

describe('offscreen page select popup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    buildFromTemplate.mockReturnValue({ popup })
  })

  it('checks for an open select only after inputs that can open one', () => {
    const mouseUp: Extract<OffscreenPageUserInput, { kind: 'mouse' }> = {
      kind: 'mouse',
      type: 'mouseUp',
      x: 0,
      y: 0,
      button: 'left',
      clickCount: 1,
      modifiers: [],
      heldButtons: []
    }
    expect(mayOpenOffscreenPageSelect(mouseUp)).toBe(true)
    expect(mayOpenOffscreenPageSelect({ ...mouseUp, type: 'mouseMove' })).toBe(false)
    const key = (name: string, code: string): OffscreenPageUserInput => ({
      kind: 'key',
      type: 'keyDown',
      key: name,
      code,
      keyCode: 0,
      location: 0,
      repeat: false,
      text: '',
      modifiers: []
    })
    expect(mayOpenOffscreenPageSelect(key('ArrowDown', 'ArrowDown'))).toBe(true)
    expect(mayOpenOffscreenPageSelect(key('a', 'KeyA'))).toBe(false)
  })

  it('rejects a malformed page answer', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the module calls.
    const contents = fakeContents({ items: [{ label: 1 }], selectedIndex: 0 }) as never
    await expect(readOpenOffscreenPageSelect(contents)).resolves.toBeNull()
  })

  it('converts the anchor from page CSS px to host CSS px', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the module calls.
    const contents = fakeContents() as never
    expect(toHostSelectAnchor(openSelect, contents, 1.2)).toEqual(openSelect.anchor)
    expect(toHostSelectAnchor(openSelect, contents, 1).width).toBeCloseTo(96)
  })

  it('builds a native menu with groups as headings and the chosen option checked', () => {
    const contents = fakeContents()
    showOffscreenPageSelectMenu({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the module calls.
      contents: contents as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the window is only forwarded to the mocked Menu.popup.
      window: {} as never,
      popup: openSelect,
      point: { x: 10.4, y: 20.6 },
      pageZoomFactor: 1
    })
    const template: MenuItemConstructorOptions[] = buildFromTemplate.mock.calls[0][0]
    expect(template.map((item) => [item.label, item.enabled, item.checked])).toEqual([
      ['alpha', true, false],
      ['Group', false, undefined],
      ['beta', true, true],
      ['gamma', false, false]
    ])
    expect(popup).toHaveBeenCalledWith(
      expect.objectContaining({ x: 10, y: 21, positioningItem: 2 })
    )
  })

  it('clicks the select closed when the menu closes while Blink still holds it open', async () => {
    const contents = fakeContents(true)
    showOffscreenPageSelectMenu({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the module calls.
      contents: contents as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the window is only forwarded to the mocked Menu.popup.
      window: {} as never,
      popup: openSelect,
      point: { x: 0, y: 0 },
      pageZoomFactor: 2
    })
    popup.mock.calls[0][0].callback()
    await vi.waitFor(() => expect(contents.sendInputEvent).toHaveBeenCalledTimes(2))
    expect(contents.sendInputEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mouseDown', x: 280, y: 420 })
    )
  })

  it('leaves the select alone when it already closed', async () => {
    const contents = fakeContents(false)
    showOffscreenPageSelectMenu({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every WebContents member the module calls.
      contents: contents as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the window is only forwarded to the mocked Menu.popup.
      window: {} as never,
      popup: openSelect,
      point: { x: 0, y: 0 },
      pageZoomFactor: 1
    })
    popup.mock.calls[0][0].callback()
    await vi.waitFor(() => expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalled())
    await Promise.resolve()
    expect(contents.sendInputEvent).not.toHaveBeenCalled()
  })
})
