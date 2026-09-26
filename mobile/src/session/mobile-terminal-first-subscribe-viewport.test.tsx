import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import { seedTerminalViewportFromCellMetrics } from './mobile-terminal-first-subscribe-viewport'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import { TerminalViewportResubscribeBudget } from './mobile-terminal-viewport-resubscribe'
import type { MobileSessionTerminalSubscriptionFoundationModel } from './use-mobile-session-terminal-subscription-foundation'
import { useMobileSessionTerminalSubscription } from './use-mobile-session-terminal-subscription'

const HANDLE = 'term-1'
const PHONE = { cols: 55, rows: 44 }

describe('seedTerminalViewportFromCellMetrics', () => {
  function seedArgs(fitDimensions: (height?: number) => typeof PHONE | null) {
    const viewportRef: { current: typeof PHONE | null } = { current: null }
    return {
      handle: HANDLE,
      ref: { fitDimensions: vi.fn(fitDimensions) },
      viewportRef,
      viewportMeasuredRef: { current: false },
      terminalFrameHeightRef: { current: 751 },
      onMeasured: vi.fn()
    }
  }

  it('sizes an unmeasured route from the reported cell box against the frame height', () => {
    const args = seedArgs(() => PHONE)
    seedTerminalViewportFromCellMetrics(args)
    expect(args.ref.fitDimensions).toHaveBeenCalledWith(751)
    expect(args.viewportRef.current).toEqual(PHONE)
    expect(args.viewportMeasuredRef.current).toBe(true)
    expect(args.onMeasured).toHaveBeenCalledWith(HANDLE, PHONE, 751)
  })

  it('leaves the route unmeasured when the document reported no cell box', () => {
    const args = seedArgs(() => null)
    seedTerminalViewportFromCellMetrics(args)
    expect(args.viewportMeasuredRef.current).toBe(false)
    expect(args.viewportRef.current).toBeNull()
  })

  it('keeps a measured viewport', () => {
    const args = seedArgs(() => PHONE)
    args.viewportMeasuredRef.current = true
    seedTerminalViewportFromCellMetrics(args)
    expect(args.ref.fitDimensions).not.toHaveBeenCalled()
  })
})

type StreamHandler = (result: unknown) => void

/** The route's subscribe, driven end to end against a recording client and terminal. */
function subscriptionHarness(fit: typeof PHONE | null) {
  const order: string[] = []
  const handlers: StreamHandler[] = []
  const terminal: TerminalWebViewHandle = {
    prepareForForegroundRecovery: vi.fn(),
    write: vi.fn(),
    init: vi.fn((cols: number, rows: number) => order.push(`init ${cols}x${rows}`)),
    resize: vi.fn(),
    reflow: vi.fn(),
    clear: vi.fn(),
    fitDimensions: vi.fn(() => fit),
    measureFitDimensions: vi.fn(async () => PHONE),
    resetZoom: vi.fn(),
    cancelSelect: vi.fn(),
    doSelectAll: vi.fn(),
    awaitReady: vi.fn(async () => {})
  }
  const terminalUnsubsRef = { current: new Map<string, () => void>() }
  const subscribeSeqRef = { current: new Map<string, number>() }
  const subscribingHandlesRef = { current: new Set<string>() }
  const initializedHandlesRef = { current: new Set<string>() }
  const fields = {
    client: {
      subscribe: vi.fn(
        (_method: string, params: Record<string, unknown>, onData: StreamHandler) => {
          order.push(`subscribe ${JSON.stringify(params.viewport ?? null)}`)
          handlers.push(onData)
          return () => {}
        }
      )
    },
    clientId: 'client-1',
    setTerminalModes: vi.fn(),
    terminalCwdRef: { current: new Map() },
    viewportRef: { current: null },
    viewportMeasuredRef: { current: false },
    terminalUnsubsRef,
    subscribingHandlesRef,
    leaseOnlyHandlesRef: { current: new Set<string>() },
    initializedHandlesRef,
    terminalDiagnosticsRef: { current: new MobileTerminalDiagnostics() },
    viewportResubscribeBudgetRef: { current: new TerminalViewportResubscribeBudget() },
    webReadyHandlesRef: { current: new Set([HANDLE]) },
    activeHandleRef: { current: HANDLE },
    subscribeSeqRef,
    layoutSeqRef: { current: new Map() },
    terminalFrameHeightRef: { current: 751 },
    scheduleDelayedAction: vi.fn(),
    showToast: vi.fn(),
    markNativeChatInputLeaseReady: vi.fn(),
    showNativeChatRef: { current: false },
    getTerminalRef: (handle: string | null) => (handle === HANDLE ? terminal : undefined),
    unsubscribeTerminal: (handle: string) => {
      terminalUnsubsRef.current.delete(handle)
      subscribingHandlesRef.current.delete(handle)
      subscribeSeqRef.current.set(handle, (subscribeSeqRef.current.get(handle) ?? 0) + 1)
    },
    unsubscribeTerminalRef: { current: vi.fn() },
    signalTerminalInventoryRecovery: vi.fn()
  }
  let subscribe: ((handle: string) => void) | undefined
  function Probe() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook destructures only the fields built above.
    const scope = fields as unknown as MobileSessionTerminalSubscriptionFoundationModel
    subscribe = useMobileSessionTerminalSubscription(scope).subscribeToTerminal
    return null
  }
  act(() => {
    renderer = create(createElement(Probe))
  })
  const scrollback = (index: number, cols: number, rows: number) =>
    act(() => {
      handlers[index]({ type: 'scrollback', seq: 1, cols, rows, serialized: 'x' })
    })
  return { order, subscribe: () => subscribe!(HANDLE), scrollback, terminal }
}

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

describe('a terminal first subscribe', () => {
  it('carries phone dims with no init before it, and paints once', async () => {
    const harness = subscriptionHarness(PHONE)
    act(() => harness.subscribe())
    expect(harness.order).toEqual(['subscribe {"cols":55,"rows":44}'])
    harness.scrollback(0, PHONE.cols, PHONE.rows)
    await act(async () => {})
    expect(harness.order).toEqual(['subscribe {"cols":55,"rows":44}', 'init 55x44'])
    expect(harness.terminal.measureFitDimensions).not.toHaveBeenCalled()
  })

  it('goes without dims when no cell box was reported, and the fit pass resubscribes once', async () => {
    const harness = subscriptionHarness(null)
    act(() => harness.subscribe())
    expect(harness.order).toEqual(['subscribe null'])
    harness.scrollback(0, 120, 40)
    await vi.waitFor(() => expect(harness.order).toHaveLength(3))
    expect(harness.order).toEqual([
      'subscribe null',
      'init 120x40',
      'subscribe {"cols":55,"rows":44}'
    ])
  })
})
