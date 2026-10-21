// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_PAGE_SURFACE_ATTRIBUTE } from '@/lib/browser-page-surface'
import { installMouseHistoryButtons } from './mouse-history-buttons'

describe('installMouseHistoryButtons', () => {
  const runHistoryAction = vi.fn()
  let uninstall: () => void

  beforeEach(() => {
    runHistoryAction.mockReset()
    uninstall = installMouseHistoryButtons(window, runHistoryAction)
  })

  afterEach(() => {
    uninstall()
    document.body.innerHTML = ''
  })

  function press(
    type: 'pointerdown' | 'pointerup' | 'pointermove',
    button: number,
    target: EventTarget = document.body,
    buttons = 0
  ): PointerEvent {
    const event = new PointerEvent(type, { button, buttons, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }

  function click(button: number, down: EventTarget, up: EventTarget = down): PointerEvent[] {
    return [press('pointerdown', button, down), press('pointerup', button, up)]
  }

  function pageSurface(markup: string): Element {
    const host = document.createElement('div')
    host.innerHTML = markup
    document.body.append(host)
    const target = host.querySelector('img, canvas')
    if (!target) {
      throw new Error('page surface markup has no img or canvas')
    }
    return target
  }

  it('runs history back on mouse Back release', () => {
    const [, up] = click(3, document.body)

    expect(runHistoryAction).toHaveBeenCalledExactlyOnceWith('worktree.history.back')
    expect(up.defaultPrevented).toBe(true)
  })

  it('runs history forward on mouse Forward release', () => {
    click(4, document.body)

    expect(runHistoryAction).toHaveBeenCalledExactlyOnceWith('worktree.history.forward')
  })

  it('cancels the press without navigating so one click moves one step', () => {
    const down = press('pointerdown', 3)
    expect(down.defaultPrevented).toBe(true)
    expect(runHistoryAction).not.toHaveBeenCalled()

    press('pointerup', 3)
    expect(runHistoryAction).toHaveBeenCalledOnce()
  })

  it('still claims a press whose pointerdown an element already cancelled', () => {
    // Why: Chromium then suppresses the compat mouse events, so only pointer listeners can act.
    const divider = document.createElement('div')
    divider.addEventListener('pointerdown', (event) => event.preventDefault())
    document.body.append(divider)

    const [, up] = click(3, divider)

    expect(up.defaultPrevented).toBe(true)
    expect(runHistoryAction).toHaveBeenCalledExactlyOnceWith('worktree.history.back')
  })

  it('handles a side button pressed and released while the primary button is held', () => {
    // Why: a chorded transition arrives as pointermove with button set, not pointerdown/up.
    press('pointerdown', 0, document.body, 1)
    const chordDown = press('pointermove', 3, document.body, 1 | 8)
    expect(chordDown.defaultPrevented).toBe(true)
    expect(runHistoryAction).not.toHaveBeenCalled()

    const chordUp = press('pointermove', 3, document.body, 1)

    expect(chordUp.defaultPrevented).toBe(true)
    expect(runHistoryAction).toHaveBeenCalledExactlyOnceWith('worktree.history.back')
  })

  it('leaves ordinary pointer moves alone', () => {
    const move = press('pointermove', -1, document.body, 1)

    expect(move.defaultPrevented).toBe(false)
    expect(runHistoryAction).not.toHaveBeenCalled()
  })

  it('cancels the side-button mouseup that carries the browser default', () => {
    // Why: a cancelled pointermove does not suppress compat mouse events the way pointerdown does.
    const event = new MouseEvent('mouseup', { button: 4, bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it.each([0, 1, 2])('ignores button %i', (button) => {
    const [down, up] = click(button, document.body)

    expect(down.defaultPrevented).toBe(false)
    expect(up.defaultPrevented).toBe(false)
    expect(runHistoryAction).not.toHaveBeenCalled()
  })

  it('cancels but does not navigate worktree history inside a browser page surface', () => {
    // Same literal markup the remote screencast frame renders.
    const frame = pageSurface('<div data-browser-page-surface=""><img></div>')
    expect(frame.closest(`[${BROWSER_PAGE_SURFACE_ATTRIBUTE}]`)).not.toBeNull()

    const [down, up] = click(3, frame)

    expect(down.defaultPrevented).toBe(true)
    expect(up.defaultPrevented).toBe(true)
    expect(runHistoryAction).not.toHaveBeenCalled()
  })

  it('cancels but does not navigate worktree history over a webview guest', () => {
    const webview = document.createElement('webview')
    document.body.append(webview)

    const [, up] = click(4, webview)

    expect(up.defaultPrevented).toBe(true)
    expect(runHistoryAction).not.toHaveBeenCalled()
  })

  it('leaves an annotation overlay drawn over a page to the page', () => {
    const canvas = pageSurface('<div data-orca-markup-overlay=""><canvas></canvas></div>')

    click(3, canvas)

    expect(runHistoryAction).not.toHaveBeenCalled()
  })

  it('keeps a press that started on a page with the page when released over Orca chrome', () => {
    const frame = pageSurface('<div data-browser-page-surface=""><img></div>')

    click(3, frame, document.body)

    expect(runHistoryAction).not.toHaveBeenCalled()
  })

  it('keeps a press that started on Orca chrome out of worktree history when released on a page', () => {
    const frame = pageSurface('<div data-browser-page-surface=""><img></div>')

    click(3, document.body, frame)

    expect(runHistoryAction).not.toHaveBeenCalled()
  })

  it('forgets a press interrupted by window blur', () => {
    const frame = pageSurface('<div data-browser-page-surface=""><img></div>')
    press('pointerdown', 3, frame)
    window.dispatchEvent(new Event('blur'))

    press('pointerup', 3, document.body)

    expect(runHistoryAction).toHaveBeenCalledOnce()
  })

  it('stops listening after uninstall', () => {
    uninstall()

    const [, up] = click(3, document.body)

    expect(up.defaultPrevented).toBe(false)
    expect(runHistoryAction).not.toHaveBeenCalled()
  })
})
