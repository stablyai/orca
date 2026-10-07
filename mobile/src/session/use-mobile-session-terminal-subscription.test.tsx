import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import { TerminalViewportResubscribeBudget } from './mobile-terminal-viewport-resubscribe'
import type { MobileSessionTerminalSubscriptionFoundationModel } from './use-mobile-session-terminal-subscription-foundation'
import { useMobileSessionTerminalSubscription } from './use-mobile-session-terminal-subscription'
import type { MobileSessionTabSwitchingModel } from './use-mobile-session-tab-switching'
import { useMobileSessionTerminalWebview } from './use-mobile-session-terminal-webview'

const HANDLE = 'term-1'
const PHONE = { cols: 55, rows: 44 }

type StreamHandler = (result: unknown) => void

/** The route's subscribe, driven end to end against a recording client and terminal. */
function subscriptionHarness(opts: {
  fit: typeof PHONE | null
  webReady: boolean
  frameWidth?: number
  viewport?: typeof PHONE
}) {
  let fit = opts.fit
  const order: string[] = []
  const handlers: StreamHandler[] = []
  const terminal: TerminalWebViewHandle = {
    prepareForForegroundRecovery: vi.fn(),
    write: vi.fn(),
    init: vi.fn(({ cols, rows }: { cols: number; rows: number }) => {
      order.push(`init ${cols}x${rows}`)
      // An init's document reports its laid-out box before its ready.
      fit = fit ?? PHONE
    }),
    resize: vi.fn(),
    reflow: vi.fn(),
    clear: vi.fn(),
    fitDimensions: vi.fn(() => fit),
    resetZoom: vi.fn(),
    cancelSelect: vi.fn(),
    doSelectAll: vi.fn(),
    awaitReady: vi.fn(async () => {})
  }
  const terminalUnsubsRef = { current: new Map<string, () => void>() }
  const subscribeSeqRef = { current: new Map<string, number>() }
  const subscribingHandlesRef = { current: new Set<string>() }
  const initializedHandlesRef = { current: new Set<string>() }
  const webReadyHandlesRef = { current: new Set<string>(opts.webReady ? [HANDLE] : []) }
  const terminalFrameRef: { current: { width: number; height: number } | null } = {
    current: opts.frameWidth === 0 ? null : { width: opts.frameWidth ?? 427, height: 751 }
  }
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
    viewportRef: { current: opts.viewport ?? null },
    viewportMeasuredRef: { current: opts.viewport !== undefined },
    terminalUnsubsRef,
    subscribingHandlesRef,
    leaseOnlyHandlesRef: { current: new Set<string>() },
    initializedHandlesRef,
    terminalDiagnosticsRef: { current: new MobileTerminalDiagnostics() },
    viewportResubscribeBudgetRef: { current: new TerminalViewportResubscribeBudget() },
    webReadyHandlesRef,
    activeHandleRef: { current: HANDLE },
    subscribeSeqRef,
    layoutSeqRef: { current: new Map() },
    terminalFrameRef,
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
    signalTerminalInventoryRecovery: vi.fn(),
    terminalRefs: { current: new Map([[HANDLE, terminal]]) },
    pendingSelectionRef: { current: null },
    nativeChatStream: { notifyWebReady: vi.fn() },
    terminalGestureInputBucketsRef: { current: new Map() },
    terminalGestureInputQueuesRef: { current: new Map() },
    terminalGestureInputInFlightRef: { current: new Map() },
    activeSessionTab: null,
    markdownDocs: new Map(),
    fileDocs: new Map(),
    readMarkdownTab: vi.fn(),
    readFileTab: vi.fn(),
    notifyTerminalFrameHeight: vi.fn(),
    notifyTerminalFrameWidth: vi.fn()
  }
  let subscribe: ((handle: string) => void) | undefined
  let webReady: ((handle: string) => void) | undefined
  let notifyFrame: ((frame: { width: number; height: number }) => void) | undefined
  function Probe() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook destructures only the fields built above.
    const scope = fields as unknown as MobileSessionTerminalSubscriptionFoundationModel
    subscribe = useMobileSessionTerminalSubscription(scope).subscribeToTerminal
    const withSubscribe = { ...fields, subscribeToTerminal: subscribe }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the web-ready handler reads only the fields built above.
    const webviewScope = withSubscribe as unknown as MobileSessionTabSwitchingModel
    const webview = useMobileSessionTerminalWebview(webviewScope)
    webReady = webview.handleTerminalWebReady
    notifyFrame = webview.notifyTerminalFrame
    return null
  }
  act(() => {
    renderer = create(createElement(Probe))
  })
  const scrollback = (index: number, cols: number, rows: number) =>
    act(() => {
      handlers[index]({ type: 'scrollback', seq: 1, cols, rows, serialized: 'x' })
    })
  return {
    order,
    subscribe: () => act(() => subscribe!(HANDLE)),
    scrollback,
    terminal,
    // The document's web-ready, carrying the box xterm laid out.
    documentReady: () => {
      act(() => webReady!(HANDLE))
    },
    fields,
    terminalFrameRef,
    // The frame's onLayout.
    layOutFrame: (width: number, height = 751) => act(() => notifyFrame!({ width, height }))
  }
}

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

describe('a terminal first subscribe', () => {
  it('does not subscribe before its document is ready, then subscribes once from its box', async () => {
    const harness = subscriptionHarness({ fit: PHONE, webReady: false })
    harness.subscribe()
    expect(harness.order).toEqual([])
    harness.documentReady()
    expect(harness.order).toEqual(['subscribe {"cols":55,"rows":44}'])
    harness.scrollback(0, PHONE.cols, PHONE.rows)
    await act(async () => {})
    expect(harness.order).toEqual(['subscribe {"cols":55,"rows":44}', 'init 55x44'])
  })

  it('resubscribes a document reloaded after its first ready, which lost its terminal', async () => {
    const harness = subscriptionHarness({ fit: PHONE, webReady: false })
    harness.documentReady()
    harness.scrollback(0, PHONE.cols, PHONE.rows)
    await act(async () => {})
    harness.documentReady()
    harness.scrollback(1, PHONE.cols, PHONE.rows)
    await act(async () => {})
    expect(harness.order.filter((step) => step.startsWith('init'))).toEqual([
      'init 55x44',
      'init 55x44'
    ])
  })

  it('sizes from the reported box against the laid-out frame', () => {
    const harness = subscriptionHarness({ fit: PHONE, webReady: true, frameWidth: 427.5 })
    harness.subscribe()
    expect(harness.terminal.fitDimensions).toHaveBeenCalledWith({ width: 427.5, height: 751 })
    expect(harness.order).toEqual(['subscribe {"cols":55,"rows":44}'])
  })

  it('keeps a measured viewport rather than fitting again', () => {
    const measured = { cols: 60, rows: 40 }
    const harness = subscriptionHarness({ fit: PHONE, webReady: true, viewport: measured })
    harness.subscribe()
    expect(harness.terminal.fitDimensions).not.toHaveBeenCalled()
    expect(harness.order).toEqual(['subscribe {"cols":60,"rows":40}'])
  })

  it('holds a ready document without a box until its frame is laid out', () => {
    const harness = subscriptionHarness({ fit: null, webReady: true, frameWidth: 0 })
    harness.subscribe()
    expect(harness.order).toEqual([])
    // The frame's first layout subscribes the document held back for it.
    harness.layOutFrame(427)
    expect(harness.order).toEqual(['subscribe null'])
  })

  it('keeps one frame, notifies a new width, and subscribes on the first layout only', () => {
    const harness = subscriptionHarness({ fit: null, webReady: true, frameWidth: 0 })
    const { notifyTerminalFrameHeight, notifyTerminalFrameWidth } = harness.fields
    harness.layOutFrame(0, 0)
    expect(harness.terminalFrameRef.current).toBeNull()
    harness.layOutFrame(427, 751)
    harness.layOutFrame(427, 700)
    expect(harness.order).toEqual(['subscribe null'])
    expect(notifyTerminalFrameWidth).not.toHaveBeenCalled()
    // A hidden 0x0 layout keeps the box it was laid out at.
    harness.layOutFrame(0, 0)
    expect(harness.terminalFrameRef.current).toEqual({ width: 427, height: 700 })
    harness.layOutFrame(360.5, 700)
    expect(harness.terminalFrameRef.current).toEqual({ width: 360.5, height: 700 })
    expect(notifyTerminalFrameWidth).toHaveBeenCalledTimes(1)
    expect(notifyTerminalFrameHeight.mock.calls.map(([height]) => height)).toEqual([
      0, 751, 700, 0, 700
    ])
  })

  it('goes without dims when no cell box was reported, and the fit pass resubscribes once', async () => {
    const harness = subscriptionHarness({ fit: null, webReady: true })
    harness.subscribe()
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
