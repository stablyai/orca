import { describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import type { HostSessionTerminalOperations } from './host-session-terminal-operations'
import { presentHostSessionTerminalStreamEvent } from './host-session-terminal-stream-presentation'
import type { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import { TerminalViewportResubscribeBudget } from './mobile-terminal-viewport-resubscribe'

const OSC_LINKS = [{ row: 0, startCol: 0, endCol: 6, uri: 'file:///tmp/prompt.ts' }]

describe('host session terminal stream presentation', () => {
  it('ACKs snapshots and output only after the existing terminal surface parses them', () => {
    const acknowledge = vi.fn()
    const init = vi.fn()
    const write = vi.fn()
    const terminalRef = { init, write } as unknown as TerminalWebViewHandle
    const context = presentationContext({ acknowledge, terminalRef })

    presentHostSessionTerminalStreamEvent({
      ...context,
      event: {
        type: 'scrollback',
        cols: 80,
        rows: 24,
        serialized: new Uint8Array([112, 114, 111, 109, 112, 116]),
        oscLinks: OSC_LINKS,
        throughSequence: 6
      }
    })
    expect(acknowledge).not.toHaveBeenCalled()
    expect(init).toHaveBeenCalledWith(
      80,
      24,
      new Uint8Array([112, 114, 111, 109, 112, 116]),
      false,
      OSC_LINKS,
      expect.any(Function)
    )
    init.mock.calls[0]![5]()
    expect(acknowledge).toHaveBeenCalledWith('terminal-page-1', 6)

    presentHostSessionTerminalStreamEvent({
      ...context,
      event: {
        type: 'data',
        chunk: new Uint8Array([36, 32]),
        throughSequence: 8
      }
    })
    expect(acknowledge).toHaveBeenCalledTimes(1)
    write.mock.calls[0]![1]()
    expect(acknowledge).toHaveBeenLastCalledWith('terminal-page-1', 8)
  })

  it('does not resubscribe a desktop-mode snapshot to the phone viewport', () => {
    const awaitReady = vi.fn()
    const measureFitDimensions = vi.fn()
    const terminalRef = {
      init: vi.fn(),
      awaitReady,
      measureFitDimensions
    } as unknown as TerminalWebViewHandle
    const context = presentationContext({ acknowledge: vi.fn(), terminalRef })
    context.viewportRef.current = { cols: 50, rows: 36 }

    presentHostSessionTerminalStreamEvent({
      ...context,
      event: {
        type: 'scrollback',
        cols: 120,
        rows: 40,
        displayMode: 'desktop',
        serialized: new Uint8Array()
      }
    })

    expect(context.setDisplayMode).toHaveBeenCalledWith('terminal-page-1', 'desktop')
    expect(awaitReady).not.toHaveBeenCalled()
    expect(measureFitDimensions).not.toHaveBeenCalled()
    expect(context.unsubscribe).not.toHaveBeenCalled()
    expect(context.subscribe).not.toHaveBeenCalled()
  })

  it('holds the stream when the host omits scrollback dims instead of refitting forever', () => {
    const awaitReady = vi.fn()
    const measureFitDimensions = vi.fn()
    const terminalRef = {
      init: vi.fn(),
      awaitReady,
      measureFitDimensions
    } as unknown as TerminalWebViewHandle
    const context = presentationContext({
      acknowledge: vi.fn(),
      terminalRef,
      viewport: { cols: 50, rows: 36 }
    })

    presentHostSessionTerminalStreamEvent({
      ...context,
      event: { type: 'scrollback', serialized: new Uint8Array() }
    })

    // Absent dims must not be coerced to 80x24 — that never equals a phone viewport (STA-3337).
    expect(context.diagnostics.streamResubscribeHeld).toHaveBeenCalledWith('terminal-page-1', 1)
    expect(awaitReady).not.toHaveBeenCalled()
    expect(measureFitDimensions).not.toHaveBeenCalled()
    expect(context.unsubscribe).not.toHaveBeenCalled()
    expect(context.subscribe).not.toHaveBeenCalled()
    expect(context.showToast).not.toHaveBeenCalled()
  })

  it('re-reads the terminal inventory when the host ends the stream', () => {
    const context = presentationContext({
      acknowledge: vi.fn(),
      terminalRef: { init: vi.fn() } as unknown as TerminalWebViewHandle
    })

    presentHostSessionTerminalStreamEvent({ ...context, event: { type: 'end' } })

    expect(context.unsubscribe).toHaveBeenCalledWith('terminal-page-1')
    expect(context.signalTerminalInventoryRecovery).toHaveBeenCalledTimes(1)
  })
})

function presentationContext(args: {
  acknowledge: ReturnType<typeof vi.fn>
  terminalRef: TerminalWebViewHandle
  viewport?: { cols: number; rows: number } | null
  viewportMeasured?: boolean
}) {
  const operations = {
    acknowledge: args.acknowledge
  } as unknown as HostSessionTerminalOperations
  const diagnostics = {
    firstStreamEvent: vi.fn(),
    streamScrollback: vi.fn(),
    streamResubscribing: vi.fn(),
    streamResubscribeHeld: vi.fn(),
    streamResubscribeExhausted: vi.fn(),
    streamResized: vi.fn()
  } as unknown as MobileTerminalDiagnostics
  return {
    handle: 'terminal-page-1',
    subscribeSequence: 1,
    isCovered: () => false,
    unsubscribe: vi.fn(),
    markInputLeaseReady: vi.fn(),
    signalTerminalInventoryRecovery: vi.fn(),
    layoutSequences: new Map<string, number>(),
    terminalCwds: new Map<string, string>(),
    getTerminalRef: () => args.terminalRef,
    operations,
    setDisplayMode: vi.fn(),
    diagnostics,
    scheduleDelayedAction: vi.fn(),
    viewportRef: {
      current: (args.viewport === undefined ? { cols: 80, rows: 24 } : args.viewport) as {
        cols: number
        rows: number
      } | null
    },
    viewportMeasuredRef: { current: args.viewportMeasured ?? true },
    terminalFrameHeightRef: { current: 400 },
    subscribeSeqRef: { current: new Map<string, number>([['terminal-page-1', 1]]) },
    initializedHandlesRef: { current: new Set<string>() },
    terminalUnsubsRef: { current: new Map<string, () => void>() },
    viewportResubscribeBudget: new TerminalViewportResubscribeBudget(),
    showToast: vi.fn(),
    subscribe: vi.fn()
  }
}
