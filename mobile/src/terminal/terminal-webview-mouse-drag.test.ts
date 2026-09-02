// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MOUSE_REPORT_RE,
  ESC,
  useTerminalMouseWebViewHarness
} from './terminal-webview-mouse-test-harness'

describe('terminal WebView external mouse drag', () => {
  const mouse = useTerminalMouseWebViewHarness()

  it('sends press, per-cell motion, and release for a drag-tracking mouse drag', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'drag'

    mouse.mouseDrag(40, 60, 160, 60)

    const reports = mouse.terminalInputBytes().match(DEFAULT_MOUSE_REPORT_RE) ?? []
    expect(reports.length).toBeGreaterThanOrEqual(3)
    expect(reports[0]?.charCodeAt(3)).toBe(32)
    for (const motion of reports.slice(1, -1)) {
      expect(motion.charCodeAt(3)).toBe(64)
    }
    expect(reports.at(-1)?.charCodeAt(3)).toBe(35)
    // Motion reports are deduped per cell, so a horizontal drag advances columns.
    const motionCols = reports.slice(1, -1).map((report) => report.charCodeAt(4))
    expect(new Set(motionCols).size).toBe(motionCols.length)
  })

  it('does not report motion or release for an x10 click-only TUI drag', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'x10'

    mouse.mouseDrag(40, 60, 160, 60)

    // x10 reports presses only; the press goes out at drag start, no motion or release follows.
    const bytes = mouse.terminalInputBytes()
    expect(bytes.slice(0, 4)).toBe(`${ESC}[M `)
    expect(bytes).toHaveLength(6)
  })

  it('selects character-anchored text on a mouse drag outside tracking mode', () => {
    mouse.boot()
    // Why: init itself emits a set-select-mode reset; only the drag matters here.
    mouse.clearPostedMessages()

    mouse.mouseDrag(40, 60, 160, 90)

    expect(mouse.terminalInputBytes()).toBe('')
    expect(mouse.selectionSpy()).toHaveBeenCalled()
    expect(document.getElementById('selection-overlay')?.classList.contains('active')).toBe(true)
    const modes = mouse.postedMessages().filter((message) => message.type === 'set-select-mode')
    expect(modes).toEqual([{ type: 'set-select-mode', enabled: true }])
  })

  it('releases a tracked drag when the button state shows the pointerup was lost', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'drag'

    mouse.dispatchPointer('pointerdown', { x: 40, y: 60, button: 0, buttons: 1 })
    mouse.dispatchPointer('pointermove', { x: 160, y: 60, button: 0, buttons: 1 })
    // Pointer re-enters with the button already up — the pointerup never arrived.
    mouse.dispatchPointer('pointermove', { x: 200, y: 60, button: 0, buttons: 0 })

    const reports = mouse.terminalInputBytes().match(DEFAULT_MOUSE_REPORT_RE) ?? []
    expect(reports.at(-1)?.charCodeAt(3)).toBe(35)

    mouse.clearPostedMessages()
    mouse.dispatchPointer('pointermove', { x: 240, y: 60, button: 0, buttons: 1 })

    // The lost pointerup ended the gesture; a later unrelated move must not emit motion.
    expect(mouse.terminalInputBytes()).toBe('')
  })

  it('releases a tracked drag when the pointer is cancelled mid-gesture', () => {
    mouse.boot()
    mouse.activeTerminal().modes.mouseTrackingMode = 'drag'

    mouse.dispatchPointer('pointerdown', { x: 40, y: 60, button: 0, buttons: 1 })
    mouse.dispatchPointer('pointermove', { x: 160, y: 60, button: 0, buttons: 1 })
    mouse.dispatchPointer('pointercancel', { x: 160, y: 60 })

    const reports = mouse.terminalInputBytes().match(DEFAULT_MOUSE_REPORT_RE) ?? []
    // Press went to the TUI, so the cancel must not leave the button latched.
    expect(reports.at(-1)?.charCodeAt(3)).toBe(35)
  })
})
