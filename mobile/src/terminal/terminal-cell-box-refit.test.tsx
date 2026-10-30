import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewHandle } from './terminal-webview-contract'
import { useTerminalViewportRefit, type TerminalViewportDims } from './terminal-viewport-refit'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  Platform: { OS: 'android' },
  useWindowDimensions: () => ({ width: 427, height: 900 })
}))

const HANDLE = 'term-1'

function refitHarness(cellWidth: number) {
  const terminal: TerminalWebViewHandle = {
    prepareForForegroundRecovery: vi.fn(),
    write: vi.fn(),
    init: vi.fn(),
    resize: vi.fn(),
    reflow: vi.fn(),
    clear: vi.fn(),
    fitDimensions: vi.fn((frame: { width: number }) => ({
      cols: Math.floor(frame.width / cellWidth),
      rows: 47
    })),
    scrollToBottom: vi.fn(),
    resetZoom: vi.fn(),
    cancelSelect: vi.fn(),
    doSelectAll: vi.fn(),
    awaitReady: vi.fn(async () => {})
  }
  const viewportRef: { current: TerminalViewportDims | null } = { current: { cols: 55, rows: 47 } }
  const subscribeToTerminal = vi.fn()
  const unsubscribeTerminal = vi.fn()
  const terminalFrameRef: { current: { width: number; height: number } | null } = {
    current: { width: 427, height: 710 }
  }
  let refit: ReturnType<typeof useTerminalViewportRefit> | undefined
  function Probe() {
    refit = useTerminalViewportRefit({
      activeHandleRef: { current: HANDLE },
      terminalRefs: { current: new Map([[HANDLE, terminal]]) },
      terminalFrameRef,
      viewportRef,
      viewportMeasuredRef: { current: true },
      nativeChatCoveredRef: { current: false },
      clientRef: { current: null },
      deviceTokenRef: { current: null },
      connState: 'connected',
      tabStripVisible: false,
      textScale: 1,
      unsubscribeTerminal,
      subscribeToTerminal
    })
    return null
  }
  act(() => {
    renderer = create(createElement(Probe))
  })
  return {
    terminal,
    viewportRef,
    subscribeToTerminal,
    report: (handle: string) => act(() => refit!.notifyTerminalCellBoxChange(handle)),
    layOut: (width: number) =>
      act(() => {
        terminalFrameRef.current = { width, height: 710 }
        refit!.notifyTerminalFrameWidth()
      })
  }
}

let renderer: ReactTestRenderer | undefined
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
})

describe('a new cell box for the open terminal', () => {
  it('updates the viewport grid and requests a resubscribe after a changed cell box', async () => {
    const harness = refitHarness(7.8)
    harness.report(HANDLE)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(harness.terminal.fitDimensions).toHaveBeenLastCalledWith({ width: 427, height: 710 })
    expect(harness.viewportRef.current).toEqual({ cols: 54, rows: 47 })
    expect(harness.subscribeToTerminal).toHaveBeenCalledWith(HANDLE)
  })

  it('leaves a terminal that is not on screen alone', async () => {
    const harness = refitHarness(7.8)
    harness.report('term-2')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(harness.subscribeToTerminal).not.toHaveBeenCalled()
    expect(harness.viewportRef.current).toEqual({ cols: 55, rows: 47 })
  })

  it('keeps the subscription when frame jitter holds the same grid', async () => {
    const harness = refitHarness(23 / 3)
    harness.layOut(427.3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(harness.subscribeToTerminal).not.toHaveBeenCalled()
    expect(harness.viewportRef.current).toEqual({ cols: 55, rows: 47 })
  })

  it('refits when a new frame width holds a different grid', async () => {
    const harness = refitHarness(23 / 3)
    harness.layOut(420)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(harness.terminal.fitDimensions).toHaveBeenLastCalledWith({ width: 420, height: 710 })
    expect(harness.viewportRef.current).toEqual({ cols: 54, rows: 47 })
  })
})
