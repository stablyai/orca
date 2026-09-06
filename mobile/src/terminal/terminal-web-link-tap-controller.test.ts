import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalWebLinkTapController } from './terminal-web-link-tap-controller'

function tapHarness(hasSelection = false) {
  let selection = hasSelection
  let bounds = { left: 0, top: 0, width: 100, height: 100 }
  const listeners = new Map<string, ((event: never) => void)[]>()
  const container = {
    addEventListener(type: string, listener: (event: never) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    removeEventListener(type: string, listener: (event: never) => void) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((candidate) => candidate !== listener)
      )
    }
  } as unknown as HTMLElement
  const terminal = {
    cols: 10,
    rows: 10,
    element: {
      getBoundingClientRect: () => bounds
    },
    buffer: { active: { viewportY: 0 } },
    hasSelection: () => selection
  } as unknown as Terminal
  const activateAtBufferCell = vi.fn(() => true)
  const cancelSelection = vi.fn()
  const onTerminalTap = vi.fn()
  const controller = createTerminalWebLinkTapController({
    container,
    terminal,
    activateAtBufferCell,
    cancelSelection,
    onTerminalTap
  })
  const dispatch = (type: string, event: object) => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event as never)
    }
  }
  return {
    activateAtBufferCell,
    cancelSelection,
    controller,
    dispatch,
    onTerminalTap,
    setSelection(value: boolean) {
      selection = value
    },
    setBounds(value: typeof bounds) {
      bounds = value
    }
  }
}

describe('hosted terminal link tap controller', () => {
  it('completes a short WKWebView touch when PointerEvents are unavailable', () => {
    const harness = tapHarness()
    const touch = { identifier: 7, clientX: 55, clientY: 45 }
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    harness.dispatch('touchstart', {
      touches: [touch],
      changedTouches: [touch]
    })
    harness.dispatch('touchend', {
      touches: [],
      changedTouches: [touch],
      preventDefault,
      stopPropagation
    })

    expect(harness.activateAtBufferCell).toHaveBeenCalledWith(4, 5)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
  })

  it('prefers WKWebView touch coordinates when pointer-up arrives first', () => {
    const harness = tapHarness()
    const touch = { identifier: 7, clientX: 55, clientY: 45 }
    harness.dispatch('pointerdown', {
      pointerType: 'touch',
      button: -1,
      pointerId: 1,
      clientX: 5,
      clientY: 5
    })
    harness.dispatch('touchstart', {
      touches: [touch],
      changedTouches: [touch]
    })
    harness.dispatch('pointerup', {
      pointerId: 1,
      clientX: 5,
      clientY: 5,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    })
    harness.dispatch('touchend', {
      touches: [],
      changedTouches: [touch],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    })

    expect(harness.activateAtBufferCell).toHaveBeenCalledOnce()
    expect(harness.activateAtBufferCell).toHaveBeenCalledWith(4, 5)
  })

  it('completes a short touch from its stored start point when pointer-up loses coordinates', () => {
    const harness = tapHarness()
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    harness.dispatch('pointerdown', {
      pointerType: 'touch',
      button: -1,
      pointerId: 1,
      clientX: 55,
      clientY: 45
    })
    harness.dispatch('pointerup', {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      preventDefault,
      stopPropagation
    })

    expect(harness.activateAtBufferCell).toHaveBeenCalledWith(4, 5)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
  })

  it('retains the touched cell when keyboard focus resizes the terminal', () => {
    const harness = tapHarness()
    harness.dispatch('pointerdown', {
      pointerType: 'touch',
      button: -1,
      pointerId: 1,
      clientX: 55,
      clientY: 45
    })
    harness.setBounds({ left: 0, top: 0, width: 100, height: 50 })
    harness.dispatch('pointerup', {
      pointerId: 1,
      clientX: 55,
      clientY: 45,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    })

    expect(harness.activateAtBufferCell).toHaveBeenCalledWith(4, 5)
  })

  it('completes a short WebKit-canceled touch from its stored start point', () => {
    const harness = tapHarness()
    harness.dispatch('pointerdown', {
      pointerType: 'touch',
      button: -1,
      pointerId: 1,
      clientX: 55,
      clientY: 45
    })
    harness.dispatch('pointercancel', { pointerId: 1, clientX: 0, clientY: 0 })

    expect(harness.activateAtBufferCell).toHaveBeenCalledWith(4, 5)
    expect(harness.onTerminalTap).not.toHaveBeenCalled()
  })

  it('uses a synthesized click to leave an active long-press selection', () => {
    const harness = tapHarness(true)
    harness.dispatch('click', {
      clientX: 55,
      clientY: 45,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    })

    expect(harness.cancelSelection).toHaveBeenCalledOnce()
    expect(harness.activateAtBufferCell).not.toHaveBeenCalled()
    expect(harness.onTerminalTap).not.toHaveBeenCalled()
  })

  it('does not activate a canceled pointer after it becomes a long-press selection', () => {
    const harness = tapHarness()
    harness.dispatch('pointerdown', {
      pointerType: 'touch',
      button: -1,
      pointerId: 1,
      clientX: 55,
      clientY: 45
    })
    harness.setSelection(true)
    harness.dispatch('pointercancel', { pointerId: 1 })

    expect(harness.activateAtBufferCell).not.toHaveBeenCalled()
    expect(harness.cancelSelection).not.toHaveBeenCalled()
  })
})
