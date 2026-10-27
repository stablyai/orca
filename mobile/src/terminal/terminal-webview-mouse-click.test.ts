// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { ESC, useTerminalMouseWebViewHarness } from './terminal-webview-mouse-test-harness'

describe('terminal WebView external mouse click', () => {
  const mouse = useTerminalMouseWebViewHarness()

  it('reports a mouse click to a click-tracking TUI the way a touch tap does (#8818)', () => {
    mouse.boot()
    mouse.writeLegacyMouseEncoding()
    mouse.activeTerminal().modes.mouseTrackingMode = 'vt200'

    mouse.mouseClick(40, 60)

    const bytes = mouse.terminalInputBytes()
    expect(bytes).toHaveLength(12)
    expect(bytes.slice(0, 4)).toBe(`${ESC}[M `)
    expect(bytes.slice(6, 10)).toBe(`${ESC}[M#`)
    expect(bytes.slice(4, 6)).toBe(bytes.slice(10, 12))
    expect(mouse.postedMessages().filter((message) => message.type === 'terminal-tap')).toEqual([])
  })

  it('sends no click report and focuses the keyboard while the encoding is unproven', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'vt200'

    mouse.mouseClick(40, 60)

    expect(mouse.terminalInputBytes()).toBe('')
    expect(
      mouse.postedMessages().filter((message) => message.type === 'terminal-tap')
    ).toHaveLength(1)
  })

  it('dismisses an existing selection with a click without focusing the keyboard', () => {
    mouse.boot()
    mouse.mouseDrag(40, 60, 160, 90)
    mouse.clearPostedMessages()

    mouse.mouseClick(240, 200)

    const messages = mouse.postedMessages()
    expect(messages.filter((message) => message.type === 'set-select-mode')).toEqual([
      { type: 'set-select-mode', enabled: false }
    ])
    expect(messages.filter((message) => message.type === 'terminal-tap')).toEqual([])
    expect(document.getElementById('selection-overlay')?.classList.contains('active')).toBe(false)
  })

  it('routes a plain mouse click to the tap pipeline for keyboard focus', () => {
    mouse.boot()

    mouse.mouseClick(40, 60)

    const messages = mouse.postedMessages()
    expect(messages.filter((message) => message.type === 'terminal-tap')).toHaveLength(1)
    expect(mouse.terminalInputBytes()).toBe('')
  })

  it('ignores non-mouse pointers and non-left buttons', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'vt200'

    mouse.dispatchPointer('pointerdown', {
      pointerType: 'touch',
      x: 40,
      y: 60,
      button: 0,
      buttons: 1
    })
    mouse.dispatchPointer('pointerup', {
      pointerType: 'touch',
      x: 40,
      y: 60,
      button: 0,
      buttons: 0
    })
    mouse.dispatchPointer('pointerdown', { x: 40, y: 60, button: 2, buttons: 2 })
    mouse.dispatchPointer('pointerup', { x: 40, y: 60, button: 2, buttons: 0 })

    expect(mouse.terminalInputBytes()).toBe('')
    expect(mouse.postedMessages().filter((message) => message.type === 'terminal-tap')).toEqual([])
  })

  it('lets the touch dispatcher own a gesture when touch events follow pointerdown', () => {
    mouse.boot()
    mouse.writeLegacyMouseEncoding()
    mouse.activeTerminal().modes.mouseTrackingMode = 'vt200'

    mouse.dispatchPointer('pointerdown', { x: 40, y: 60, button: 0, buttons: 1 })
    const touchStart = new Event('touchstart', { bubbles: true })
    // Happy DOM plain events lack touches; provide the list read by the real dispatcher.
    Object.defineProperty(touchStart, 'touches', {
      value: [{ identifier: 7, clientX: 40, clientY: 60 }]
    })
    mouse.terminalSurface().dispatchEvent(touchStart)
    mouse.dispatchPointer('pointerup', { x: 40, y: 60, button: 0, buttons: 0 })

    // Android may emit mouse-flavored pointerdown and real touches for one injected gesture; handle it only once.
    expect(mouse.terminalInputBytes()).toBe('')
  })
})
