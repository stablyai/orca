// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { useTerminalMouseWebViewHarness } from './terminal-webview-mouse-test-harness'

// Why: while a TUI owns mouse tracking, a left drag reports to the app instead
// of selecting — desktop terminals offer Shift+drag; on touch hardware the
// right button is the only always-available override.
describe('terminal WebView mouse selection overrides', () => {
  const mouse = useTerminalMouseWebViewHarness()

  it('selects on a right-button drag even while a TUI owns mouse tracking', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'any'

    mouse.mouseRightDrag(40, 60, 160, 90)

    expect(mouse.terminalInputBytes()).toBe('')
    expect(mouse.selectionSpy()).toHaveBeenCalled()
    expect(document.getElementById('selection-overlay')?.classList.contains('active')).toBe(true)
    expect(mouse.postedMessages()).toContainEqual({ type: 'set-select-mode', enabled: true })
  })

  it('selects on a right-button drag when the terminal has no mouse tracking', () => {
    mouse.boot()

    mouse.mouseRightDrag(40, 60, 160, 90)

    expect(mouse.terminalInputBytes()).toBe('')
    expect(mouse.selectionSpy()).toHaveBeenCalled()
    expect(document.getElementById('selection-overlay')?.classList.contains('active')).toBe(true)
  })

  it('word-selects on a right-button click without dragging, even in a tracking TUI', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'any'

    mouse.mouseRightClick(40, 60)

    expect(mouse.terminalInputBytes()).toBe('')
    expect(mouse.postedMessages().filter((message) => message.type === 'terminal-tap')).toEqual([])
    expect(mouse.postedMessages()).toContainEqual({ type: 'set-select-mode', enabled: true })
    expect(mouse.postedMessages()).toContainEqual({ type: 'haptic', kind: 'selection' })
    expect(mouse.selectionSpy()).toHaveBeenCalled()
  })

  it('abandons a right-button press whose button is lost mid-drag, without reports', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'any'

    mouse.dispatchPointer('pointerdown', { x: 40, y: 60, button: 2, buttons: 2 })
    mouse.dispatchPointer('pointermove', { x: 200, y: 60, button: 2, buttons: 0 })
    expect(mouse.terminalInputBytes()).toBe('')

    mouse.mouseRightClick(40, 60)
    expect(mouse.postedMessages()).toContainEqual({ type: 'set-select-mode', enabled: true })
  })

  it('prevents the native context menu on the surface', () => {
    mouse.boot()

    const event = mouse.dispatchContextMenu(40, 60)

    expect(event.defaultPrevented).toBe(true)
  })

  it('word-selects on a left-button double click in a plain terminal', () => {
    mouse.boot()

    mouse.mouseClick(40, 60)
    mouse.mouseClick(40, 60)

    expect(
      mouse.postedMessages().filter((message) => message.type === 'terminal-tap')
    ).toHaveLength(1)
    expect(mouse.postedMessages()).toContainEqual({ type: 'set-select-mode', enabled: true })
    expect(mouse.postedMessages()).toContainEqual({ type: 'haptic', kind: 'selection' })
    expect(mouse.selectionSpy()).toHaveBeenCalled()
  })

  it('keeps TUI double clicks untouched by the word-selection override', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'vt200'
    mouse.clearPostedMessages()

    mouse.mouseClick(40, 60)
    mouse.mouseClick(40, 60)

    expect(mouse.terminalInputBytes()).toHaveLength(24)
    expect(mouse.postedMessages().filter((message) => message.type === 'set-select-mode')).toEqual(
      []
    )
    expect(document.getElementById('selection-overlay')?.classList.contains('active')).toBe(false)
  })

  it('re-selects on a double click that follows a selection-dismissing click', () => {
    mouse.boot()
    mouse.mouseDrag(40, 60, 160, 90)
    mouse.clearPostedMessages()

    mouse.mouseClick(240, 200)
    mouse.mouseClick(240, 200)

    const modes = mouse.postedMessages().filter((message) => message.type === 'set-select-mode')
    expect(modes.at(-1)).toEqual({ type: 'set-select-mode', enabled: true })
    expect(document.getElementById('selection-overlay')?.classList.contains('active')).toBe(true)
  })

  it('does not double-click a tap that follows a cancelled gesture', () => {
    mouse.boot()
    mouse.mouseClick(40, 60)
    mouse.clearPostedMessages()

    mouse.dispatchPointer('pointerdown', { x: 40, y: 60, button: 0, buttons: 1 })
    mouse.dispatchPointer('pointercancel')
    mouse.mouseClick(40, 60)

    expect(mouse.postedMessages().filter((message) => message.type === 'set-select-mode')).toEqual(
      []
    )
    expect(mouse.selectionSpy()).not.toHaveBeenCalled()
    expect(
      mouse.postedMessages().filter((message) => message.type === 'terminal-tap')
    ).toHaveLength(1)
  })

  it('pairs only clean taps when a drag intervenes between clicks', () => {
    mouse.boot()
    mouse.mouseClick(40, 60)
    mouse.mouseDrag(40, 60, 160, 90)
    mouse.clearPostedMessages()

    // 48,64 is within DOUBLE_CLICK_SLOP of the pre-drag tap, so a stale pair
    // would eat the first of these clicks and the double click would die.
    mouse.mouseClick(48, 64)
    // The first post-drag click must only dismiss the drag's selection (its
    // enabled:false post); pairing against the stale pre-drag anchor here
    // would word-select and consume the pair.
    expect(
      mouse
        .postedMessages()
        .filter((message) => message.type === 'set-select-mode' && message.enabled === true)
    ).toEqual([])

    mouse.mouseClick(48, 64)

    const modes = mouse.postedMessages().filter((message) => message.type === 'set-select-mode')
    expect(modes.at(-1)).toEqual({ type: 'set-select-mode', enabled: true })
  })
})
