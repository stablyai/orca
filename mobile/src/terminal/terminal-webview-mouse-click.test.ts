// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { ESC, useTerminalMouseWebViewHarness } from './terminal-webview-mouse-test-harness'

describe('terminal WebView external mouse click', () => {
  const mouse = useTerminalMouseWebViewHarness()

  it('reports a mouse click to a click-tracking TUI the way a touch tap does (#8818)', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'vt200'

    mouse.mouseClick(40, 60)

    // Default (non-SGR) encoding: press (32=' ') then release (35='#'), each
    // ESC [ M btn col row. Cell bytes depend on the fit scale, not on routing.
    const bytes = mouse.terminalInputBytes()
    expect(bytes).toHaveLength(12)
    expect(bytes.slice(0, 4)).toBe(`${ESC}[M `)
    expect(bytes.slice(6, 10)).toBe(`${ESC}[M#`)
    expect(bytes.slice(4, 6)).toBe(bytes.slice(10, 12))
    expect(mouse.postedMessages().filter((message) => message.type === 'terminal-tap')).toEqual([])
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

  it('raises the keyboard for a mouse click on Android, even inside a click-tracking TUI', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'vt200'
    mouse.stubPointerEnvironment({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
    })

    mouse.mouseClick(40, 60)

    // Touch parity: the TUI still consumes its click report, but the tap also
    // reaches the native input focus so the soft keyboard opens.
    expect(mouse.terminalInputBytes()).not.toBe('')
    expect(
      mouse.postedMessages().filter((message) => message.type === 'terminal-tap')
    ).toHaveLength(1)
  })

  it('keeps mouse clicks silent for iPad pointer users (#12772)', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'vt200'
    mouse.stubPointerEnvironment({
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1'
    })

    mouse.mouseClick(40, 60)

    expect(mouse.terminalInputBytes()).not.toBe('')
    expect(mouse.postedMessages().filter((message) => message.type === 'terminal-tap')).toEqual([])
  })

  it('ignores non-mouse pointers', () => {
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

    expect(mouse.terminalInputBytes()).toBe('')
    expect(mouse.postedMessages().filter((message) => message.type === 'terminal-tap')).toEqual([])
  })

  it('lets the touch dispatcher own a gesture when touch events follow pointerdown', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'vt200'

    mouse.dispatchPointer('pointerdown', { x: 40, y: 60, button: 0, buttons: 1 })
    const touchStart = new Event('touchstart', { bubbles: true })
    // Why: the document tap dispatcher reads touches[0]; happy-dom's plain Event lacks it.
    Object.defineProperty(touchStart, 'touches', {
      value: [{ identifier: 7, clientX: 40, clientY: 60 }]
    })
    mouse.terminalSurface().dispatchEvent(touchStart)
    mouse.dispatchPointer('pointerup', { x: 40, y: 60, button: 0, buttons: 0 })

    // Why: Android SOURCE_MOUSE injections can pair a mouse pointerdown with
    // real touch events; double-handling would double the click report.
    expect(mouse.terminalInputBytes()).toBe('')
  })
})
