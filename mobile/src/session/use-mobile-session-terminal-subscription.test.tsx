// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { createElement } from 'react'
import { createTerminalDocumentScope } from '../terminal/document/document-scope'
import {
  startTerminalDocument,
  stopTerminalDocument
} from '../terminal/document/create-terminal-document'
import { handleMsg } from '../terminal/document/host-message-router'
import type { TerminalDocumentTerminal } from '../terminal/document/document-terminal-shape'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal/terminal-webview-html/document-markup'
import { recoverActiveTerminalAfterForeground } from '../terminal/terminal-foreground-recovery'
import type { ConnectionState } from '../transport/types'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import { terminalPaneViewport, type TerminalPaneViewport } from './mobile-terminal-pane-layout'
import { TerminalViewportResubscribeBudget } from './mobile-terminal-viewport-resubscribe'
import type { MobileSessionTerminalSubscriptionFoundationModel } from './use-mobile-session-terminal-subscription-foundation'
import { useMobileSessionTerminalSubscription } from './use-mobile-session-terminal-subscription'
import type { MobileSessionTabSwitchingModel } from './use-mobile-session-tab-switching'
import { useMobileSessionTerminalWebview } from './use-mobile-session-terminal-webview'

const HANDLE = 'term-1'
const PHONE = { cols: 55, rows: 44 }

type StreamHandler = (result: unknown) => void

function subscriptionHarness(opts: {
  fit: typeof PHONE | null
  webReady: boolean
  frameWidth?: number
  viewport?: typeof PHONE
  synchronousEvents?: unknown[]
  split?: boolean
}) {
  let fit = opts.fit
  const order: string[] = []
  const handlers: StreamHandler[] = []
  const stopStream = vi.fn()
  const terminal: TerminalWebViewHandle = {
    prepareForForegroundRecovery: vi.fn(),
    write: vi.fn(),
    init: vi.fn(({ cols, rows }: { cols: number; rows: number }) => {
      order.push(`init ${cols}x${rows}`)
      fit = fit ?? PHONE
    }),
    resize: vi.fn(),
    reflow: vi.fn(),
    clear: vi.fn(),
    fitDimensions: vi.fn(() => fit),
    scrollToBottom: vi.fn(),
    resetZoom: vi.fn(),
    cancelSelect: vi.fn(),
    doSelectAll: vi.fn(),
    awaitReady: vi.fn(async () => {})
  }
  let currentTerminal: TerminalWebViewHandle | undefined = terminal
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
          opts.synchronousEvents?.forEach(onData)
          return stopStream
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
    activeHandle: HANDLE,
    terminals: [{ handle: HANDLE, title: 'Terminal', isActive: true }],
    splitTerminalHandles: null,
    setSplitTerminalHandles: vi.fn(),
    visibleTerminalHandles: [HANDLE],
    visibleTerminalHandlesRef: { current: [HANDLE] },
    showNativeChat: false,
    switchTab: vi.fn(),
    handleTerminalTap: vi.fn(),
    subscribeSeqRef,
    layoutSeqRef: { current: new Map() },
    terminalFrameRef,
    scheduleDelayedAction: vi.fn<(fn: () => void, ms: number) => void>(),
    showToast: vi.fn(),
    markNativeChatInputLeaseReady: vi.fn(),
    showNativeChatRef: { current: false },
    getTerminalRef: (handle: string | null) => (handle === HANDLE ? currentTerminal : undefined),
    unsubscribeTerminal: (handle: string) => {
      terminalUnsubsRef.current.get(handle)?.()
      terminalUnsubsRef.current.delete(handle)
      subscribingHandlesRef.current.delete(handle)
      initializedHandlesRef.current.delete(handle)
      subscribeSeqRef.current.set(handle, (subscribeSeqRef.current.get(handle) ?? 0) + 1)
    },
    unsubscribeTerminalRef: { current: vi.fn() },
    signalTerminalInventoryRecovery: vi.fn(),
    terminalRefs: { current: new Map([[HANDLE, terminal]]) },
    terminalPaneViewportsRef: { current: new Map<string, TerminalPaneViewport>() },
    pendingSelectionRef: { current: null },
    nativeChatStream: { notifyWebReady: vi.fn() },
    terminalGestureInputBucketsRef: { current: new Map() },
    terminalGestureInputQueuesRef: { current: new Map() },
    terminalGestureInputInFlightRef: { current: new Set() },
    activeSessionTab: null,
    markdownDocs: new Map(),
    fileDocs: new Map(),
    readMarkdownTab: vi.fn(),
    readFileTab: vi.fn(),
    notifyTerminalFrameHeight: vi.fn(),
    notifyTerminalFrameWidth: vi.fn()
  }
  const second = {
    ...terminal,
    write: vi.fn(),
    init: vi.fn(),
    fitDimensions: vi.fn(() => ({ cols: 30, rows: 20 }))
  }
  const secondGeometry: TerminalPaneViewport = {
    terminalFrameRef: { current: { width: 240, height: 320 } },
    viewportRef: { current: null },
    viewportMeasuredRef: { current: false }
  }
  fields.terminalPaneViewportsRef.current.set(HANDLE, {
    terminalFrameRef: fields.terminalFrameRef,
    viewportRef: fields.viewportRef,
    viewportMeasuredRef: fields.viewportMeasuredRef
  })
  fields.terminalPaneViewportsRef.current.set('term-2', secondGeometry)
  if (opts.split) {
    fields.terminals.push({ handle: 'term-2', title: 'Second', isActive: false })
    fields.visibleTerminalHandles.push('term-2')
    fields.visibleTerminalHandlesRef.current.push('term-2')
    fields.webReadyHandlesRef.current.add('term-2')
    fields.terminalRefs.current.set('term-2', second)
  }
  fields.getTerminalRef = (handle: string | null) =>
    handle === HANDLE ? currentTerminal : handle === 'term-2' && opts.split ? second : undefined
  fields.unsubscribeTerminalRef.current.mockImplementation(fields.unsubscribeTerminal)
  let subscribe: ((handle: string) => void) | undefined
  let webReady: ((handle: string) => void) | undefined
  let setRef: ((handle: string, ref: TerminalWebViewHandle | null) => void) | undefined
  let notifyFrame: ((frame: { width: number; height: number }) => void) | undefined
  function Probe() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook destructures only the fields built above.
    const scope = {
      ...fields,
      getTerminalPaneViewport: (handle: string) =>
        terminalPaneViewport(fields.terminalPaneViewportsRef.current, handle)
    } as unknown as MobileSessionTerminalSubscriptionFoundationModel
    subscribe = useMobileSessionTerminalSubscription(scope).subscribeToTerminal
    const withSubscribe = {
      ...fields,
      subscribeToTerminal: subscribe,
      getTerminalPaneViewport: (handle: string) =>
        terminalPaneViewport(fields.terminalPaneViewportsRef.current, handle)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the web-ready handler reads only the fields built above.
    const webviewScope = withSubscribe as unknown as MobileSessionTabSwitchingModel
    const webview = useMobileSessionTerminalWebview(webviewScope)
    webReady = webview.handleTerminalWebReady
    setRef = webview.setTerminalWebViewRef
    notifyFrame = (frame) => webview.notifyTerminalPaneFrame(HANDLE, frame)
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
    stopStream,
    subscribe: () => act(() => subscribe!(HANDLE)),
    subscribeHandle: (handle: string) => act(() => subscribe!(handle)),
    second,
    scrollback,
    terminal,
    event: (index: number, data: unknown) => act(() => handlers[index](data)),
    replaceTerminal: (next: TerminalWebViewHandle) => {
      currentTerminal = next
      fields.terminalRefs.current.set(HANDLE, next)
    },
    replaceImperativeHandle: () =>
      act(() => {
        setRef!(HANDLE, null)
        currentTerminal = { ...terminal }
        setRef!(HANDLE, currentTerminal)
      }),
    // The document's web-ready, carrying the box xterm laid out.
    documentReady: () => {
      act(() => webReady!(HANDLE))
    },
    fields,
    terminalFrameRef,
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
    harness.layOutFrame(0, 0)
    expect(harness.terminalFrameRef.current).toEqual({ width: 427, height: 700 })
    harness.layOutFrame(360.5, 700)
    expect(harness.terminalFrameRef.current).toEqual({ width: 360.5, height: 700 })
    expect(notifyTerminalFrameWidth).toHaveBeenCalledTimes(1)
    expect(notifyTerminalFrameHeight.mock.calls.map(([height]) => height)).toEqual([751, 700, 700])
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

describe('settled terminal fits belong to their stream and document', () => {
  function start() {
    const harness = subscriptionHarness({ fit: PHONE, webReady: true, viewport: PHONE })
    harness.subscribe()
    harness.scrollback(0, PHONE.cols, PHONE.rows)
    return harness
  }
  function fits(harness: ReturnType<typeof subscriptionHarness>) {
    return harness.fields.scheduleDelayedAction.mock.calls
      .filter(([, delay]) => delay === 200)
      .map(([callback]) => callback)
  }
  function clearStreamCache(harness: ReturnType<typeof subscriptionHarness>) {
    harness.fields.terminalUnsubsRef.current.forEach((unsub) => unsub())
    harness.fields.terminalUnsubsRef.current.clear()
    harness.fields.subscribeSeqRef.current.clear()
    harness.fields.initializedHandlesRef.current.clear()
    harness.fields.webReadyHandlesRef.current.clear()
    harness.fields.webReadyHandlesRef.current.add(HANDLE)
  }

  it('still fits a current initial snapshot after the same settling delay', () => {
    const h = start()
    expect(fits(h)).toHaveLength(1)
    act(() => fits(h)[0]())
    expect(h.terminal.resetZoom).toHaveBeenCalledTimes(1)
  })
  it('does not fit after the stream was unsubscribed', () => {
    const h = start()
    h.fields.unsubscribeTerminal(HANDLE)
    act(() => fits(h)[0]())
    expect(h.terminal.resetZoom).not.toHaveBeenCalled()
  })
  it('lets only the fresh subscription fit a reused terminal handle', () => {
    const h = start()
    h.fields.unsubscribeTerminal(HANDLE)
    h.subscribe()
    h.scrollback(1, PHONE.cols, PHONE.rows)
    act(() => fits(h)[0]())
    expect(h.terminal.resetZoom).not.toHaveBeenCalled()
    act(() => fits(h)[1]())
    expect(h.terminal.resetZoom).toHaveBeenCalledTimes(1)
  })
  it('rejects the retired fit even when a cache clear reuses numeric sequence one', () => {
    const h = start()
    clearStreamCache(h)
    h.subscribe()
    h.scrollback(1, PHONE.cols, PHONE.rows)
    expect(h.fields.subscribeSeqRef.current.get(HANDLE)).toBe(1)
    act(() => fits(h)[0]())
    expect(h.terminal.resetZoom).not.toHaveBeenCalled()
    act(() => fits(h)[1]())
    expect(h.terminal.resetZoom).toHaveBeenCalledTimes(1)
  })
  it('rejects late data from a retired stream when a fresh stream reused its number', () => {
    const h = start()
    clearStreamCache(h)
    h.subscribe()
    h.scrollback(1, PHONE.cols, PHONE.rows)
    h.event(0, { type: 'data', chunk: 'retired output' })
    expect(h.terminal.write).not.toHaveBeenCalled()
    h.event(1, { type: 'data', chunk: 'fresh output' })
    expect(h.terminal.write).toHaveBeenCalledExactlyOnceWith('fresh output')
  })
  it('does not send the previous document fit to a replacement WebView', () => {
    const h = start()
    const replacement = { ...h.terminal, resetZoom: vi.fn() }
    h.replaceTerminal(replacement)
    act(() => fits(h)[0]())
    expect(h.terminal.resetZoom).not.toHaveBeenCalled()
    expect(replacement.resetZoom).not.toHaveBeenCalled()
  })
  it('keeps only the latest accepted layout fit within one stream', () => {
    const h = start()
    h.event(0, { type: 'resized', seq: 2, cols: 60, rows: 40, serialized: 'first' })
    h.event(0, { type: 'resized', seq: 3, cols: 62, rows: 42, serialized: 'latest' })
    expect(fits(h)).toHaveLength(3)
    act(() => {
      fits(h)[0]()
      fits(h)[1]()
    })
    expect(h.terminal.resetZoom).not.toHaveBeenCalled()
    act(() => fits(h)[2]())
    expect(h.terminal.resetZoom).toHaveBeenCalledTimes(1)
  })
  it('retires the fit when the stream ends', () => {
    const h = start()
    h.event(0, { type: 'end' })
    act(() => fits(h)[0]())
    expect(h.terminal.resetZoom).not.toHaveBeenCalled()
    expect(h.fields.signalTerminalInventoryRecovery).toHaveBeenCalledTimes(1)
  })
  it('still fits the current geometry-only resize', () => {
    const h = start()
    h.event(0, { type: 'resized', seq: 2, cols: 60, rows: 40 })
    expect(h.terminal.resize).toHaveBeenCalledWith(60, 40, h.terminalFrameRef.current)
    act(() => fits(h)[1]())
    expect(h.terminal.resetZoom).toHaveBeenCalledTimes(1)
  })
  it('does not let an ignored older resize invalidate the latest accepted fit', () => {
    const h = start()
    h.event(0, { type: 'resized', seq: 3, cols: 60, rows: 40 })
    h.event(0, { type: 'resized', seq: 2, cols: 62, rows: 42 })
    expect(fits(h)).toHaveLength(2)
    act(() => fits(h)[1]())
    expect(h.terminal.resetZoom).toHaveBeenCalledTimes(1)
  })
})

describe('a stream terminating while subscribe is still returning', () => {
  it.each(['end', 'error'])('retires synchronous %s before registering the unsubscribe', (type) => {
    const h = subscriptionHarness({
      fit: PHONE,
      webReady: true,
      viewport: PHONE,
      synchronousEvents: [{ type }, { type: 'data', chunk: 'retired output' }, { type }]
    })
    h.subscribe()
    expect(h.fields.terminalUnsubsRef.current.size).toBe(0)
    expect(h.fields.subscribingHandlesRef.current.size).toBe(0)
    expect(h.terminal.write).not.toHaveBeenCalled()
    expect(h.stopStream).toHaveBeenCalledTimes(1)
    expect(h.fields.signalTerminalInventoryRecovery).toHaveBeenCalledTimes(1)
  })
})

describe('foreground snapshots preserve the terminal reading position', () => {
  it.each(['connected', 'reconnecting'] as const)(
    'restores the reading row after recovery from %s',
    async (connectionState) => {
      const h = subscriptionHarness({ fit: PHONE, webReady: true, viewport: PHONE })
      document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
      let ready = Promise.resolve()
      let resolveReady = () => {}
      const scope = createTerminalDocumentScope({
        installHostTransport: () => () => {},
        hasEngine: () => true,
        createTerminal: (options) => {
          const terminal = new Terminal(options)
          terminal.open = () => {}
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm implements the document API; its options are initialized by the document.
          return terminal as unknown as TerminalDocumentTerminal
        },
        createWebglAddon: () => null,
        createUnicode11Addon: () => null,
        postToHost: (message) => {
          if (message.type === 'ready') {
            resolveReady()
          }
        }
      })
      startTerminalDocument(scope)
      try {
        vi.mocked(h.terminal.init).mockImplementation((options) => {
          ready = new Promise((resolve) => {
            resolveReady = resolve
          })
          handleMsg(scope, { type: 'init', ...options })
        })
        const snapshot = Array.from({ length: 200 }, (_, row) => `LINE_${row}`).join('\r\n')
        const replay = async (serialized: unknown = snapshot) => {
          h.event(h.fields.client.subscribe.mock.calls.length - 1, {
            type: 'scrollback',
            cols: PHONE.cols,
            rows: PHONE.rows,
            serialized
          })
          await ready
        }
        h.subscribe()
        await replay()
        expect(scope.term!.buffer.active.viewportY).toBe(scope.term!.buffer.active.baseY)
        scope.term!.scrollToLine(40)
        const readingRow = scope.term!.buffer.active.getLine(40)?.translateToString(true)
        const connStateRef: { current: ConnectionState } = { current: connectionState }
        const scheduled: Array<() => void> = []
        const recover = () =>
          recoverActiveTerminalAfterForeground({
            ...h.fields,
            connStateRef,
            subscribeToTerminal: h.subscribe,
            schedule: (callback) => scheduled.push(callback)
          })
        if (connectionState === 'reconnecting') {
          expect(recover()).toBe('deferred')
          connStateRef.current = 'connected'
        }
        expect(recover()).toBe('recovered')
        scheduled.splice(0).forEach((callback) => callback())
        await replay()
        expect(scope.term!.buffer.active.viewportY).toBe(40)
        expect(scope.term!.buffer.active.getLine(40)?.translateToString(true)).toBe(readingRow)

        scope.term!.scrollToBottom()
        recover()
        scheduled.splice(0).forEach((callback) => callback())
        await replay()
        expect(scope.term!.buffer.active.viewportY).toBe(scope.term!.buffer.active.baseY)

        scope.term!.scrollToLine(40)
        recover()
        scheduled.splice(0).forEach((callback) => callback())
        await replay('')
        expect(scope.term!.buffer.active.viewportY).toBe(0)
        expect(scope.term!.buffer.active.baseY).toBe(0)
      } finally {
        stopTerminalDocument(scope)
      }
    }
  )
})

describe('two visible terminal subscriptions', () => {
  it('retains a split pane frame when a mounted document replaces its imperative handle', () => {
    const harness = subscriptionHarness({ fit: PHONE, webReady: true, split: true })
    harness.fields.unsubscribeTerminal(HANDLE)
    vi.mocked(harness.terminal.fitDimensions).mockImplementation((frame) => ({
      cols: Math.floor(frame.width / 8),
      rows: Math.floor(frame.height / 16)
    }))
    harness.layOutFrame(376, 224)
    harness.fields.unsubscribeTerminal(HANDLE)
    const priorSubscriptions = harness.fields.client.subscribe.mock.calls.length
    harness.replaceImperativeHandle()
    harness.subscribe()
    expect(harness.fields.client.subscribe).toHaveBeenCalledTimes(priorSubscriptions + 1)
    expect(harness.fields.client.subscribe.mock.calls.at(-1)?.[1]).toMatchObject({
      terminal: HANDLE,
      viewport: { cols: 47, rows: 14 }
    })
    expect(
      harness.fields.terminalPaneViewportsRef.current.get(HANDLE)?.terminalFrameRef.current
    ).toEqual({ width: 376, height: 224 })
  })

  it('subscribes and renders both streams with their own measured grids', () => {
    const harness = subscriptionHarness({ fit: PHONE, webReady: true, split: true })
    harness.subscribe()
    harness.subscribeHandle('term-2')
    const requests = harness.fields.client.subscribe.mock.calls
    expect(requests.map((call) => [call[1].terminal, call[1].viewport])).toEqual([
      [HANDLE, PHONE],
      ['term-2', { cols: 30, rows: 20 }]
    ])
    harness.scrollback(0, PHONE.cols, PHONE.rows)
    harness.scrollback(1, 30, 20)
    harness.event(0, { type: 'data', chunk: 'first' })
    harness.event(1, { type: 'data', chunk: 'second' })
    expect(harness.terminal.write).toHaveBeenCalledWith('first')
    expect(harness.terminal.write).not.toHaveBeenCalledWith('second')
    expect(harness.second.write).toHaveBeenCalledWith('second')
    expect(harness.second.init).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 30, rows: 20, frame: { width: 240, height: 320 } })
    )
    harness.fields.activeHandleRef.current = 'term-2'
    harness.event(0, { type: 'data', chunk: 'still live' })
    expect(harness.terminal.write).toHaveBeenCalledWith('still live')
    expect(harness.fields.terminalUnsubsRef.current.size).toBe(2)
  })
})
