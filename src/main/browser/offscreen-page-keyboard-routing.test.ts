import { describe, expect, it, vi } from 'vitest'
import type { GuestShortcutForwardContext } from './browser-guest-shortcut-dispatch'
import {
  clearOffscreenPageKeyboardFocus,
  routeOffscreenPageShortcut,
  routeOffscreenPageZoomCommand,
  setOffscreenPageKeyboardFocus,
  setOffscreenPageShortcutContext
} from './offscreen-page-keyboard-routing'

const RENDERER = 7
const mod = process.platform === 'darwin' ? { meta: true } : { control: true }

function register(pageId: string) {
  const renderer = { send: vi.fn() }
  const context: GuestShortcutForwardContext = {
    browserTabId: pageId,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the forwarder only calls send on the renderer.
    resolveRenderer: () => renderer as never,
    forwardBrowserPageZoom: vi.fn()
  }
  setOffscreenPageShortcutContext(pageId, context)
  return { renderer, context }
}

function key(input: Record<string, unknown>) {
  const event = { preventDefault: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only preventDefault from the event.
  const claimed = routeOffscreenPageShortcut(RENDERER, event as never, {
    type: 'keyDown',
    ...input
  })
  return { claimed, event }
}

describe('offscreen page keyboard routing', () => {
  it('routes page chords to the page that holds keyboard focus', () => {
    const { renderer } = register('page-a')
    expect(key({ key: 'r', code: 'KeyR', ...mod }).claimed).toBe(false)

    setOffscreenPageKeyboardFocus(RENDERER, 'page-a', true)
    const reload = key({ key: 'r', code: 'KeyR', ...mod })
    expect(reload.claimed).toBe(true)
    expect(reload.event.preventDefault).toHaveBeenCalled()
    expect(renderer.send).toHaveBeenCalledWith('ui:reloadBrowserPage', {
      browserPageId: 'page-a'
    })
    expect(key({ key: 'a', code: 'KeyA' }).claimed).toBe(false)
    setOffscreenPageShortcutContext('page-a', null)
  })

  it('zooms the focused page for native zoom commands', () => {
    const { context } = register('page-b')
    const event = { preventDefault: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only preventDefault from the event.
    expect(routeOffscreenPageZoomCommand(RENDERER, event as never, 'in')).toBe(false)
    setOffscreenPageKeyboardFocus(RENDERER, 'page-b', true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only preventDefault from the event.
    expect(routeOffscreenPageZoomCommand(RENDERER, event as never, 'in')).toBe(true)
    expect(context.forwardBrowserPageZoom).toHaveBeenCalledWith(event, 'in')
    setOffscreenPageShortcutContext('page-b', null)
  })

  it('forgets focus on blur of that page, page teardown and renderer reload', () => {
    register('page-c')
    register('page-d')
    setOffscreenPageKeyboardFocus(RENDERER, 'page-c', true)
    setOffscreenPageKeyboardFocus(RENDERER, 'page-d', false)
    expect(key({ key: 'r', code: 'KeyR', ...mod }).claimed).toBe(true)
    setOffscreenPageKeyboardFocus(RENDERER, 'page-c', false)
    expect(key({ key: 'r', code: 'KeyR', ...mod }).claimed).toBe(false)

    setOffscreenPageKeyboardFocus(RENDERER, 'page-c', true)
    setOffscreenPageShortcutContext('page-c', null)
    register('page-c')
    expect(key({ key: 'r', code: 'KeyR', ...mod }).claimed).toBe(false)

    setOffscreenPageKeyboardFocus(RENDERER, 'page-d', true)
    clearOffscreenPageKeyboardFocus(RENDERER)
    expect(key({ key: 'r', code: 'KeyR', ...mod }).claimed).toBe(false)
  })
})
