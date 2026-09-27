import { Terminal } from '@xterm/xterm'
import { createElement, useEffect } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, vi } from 'vitest'
import { MobileTerminalDiagnostics } from '../session/mobile-terminal-diagnostics'
import { TerminalViewportResubscribeBudget } from '../session/mobile-terminal-viewport-resubscribe'
import { useMobileSessionTerminalSubscription } from '../session/use-mobile-session-terminal-subscription'
import type { MobileSessionTerminalSubscriptionFoundationModel } from '../session/use-mobile-session-terminal-subscription-foundation'
import type { ConnectionState } from '../transport/types'
import { startTerminalDocument, stopTerminalDocument } from './document/create-terminal-document'
import { createTerminalDocumentScope } from './document/document-scope'
import type { TerminalDocumentTerminal } from './document/document-terminal-shape'
import { handleMsg } from './document/host-message-router'
import { TERMINAL_DOCUMENT_MARKUP } from './terminal-webview-html/document-markup'
import type { TerminalWebViewHandle } from './terminal-webview-contract'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
})

export function createForegroundReplayHarness() {
  document.body.innerHTML = TERMINAL_DOCUMENT_MARKUP
  let ready = Promise.resolve()
  let resolveReady = () => {}
  const documentScope = createTerminalDocumentScope({
    installHostTransport: () => () => {},
    hasEngine: () => true,
    createTerminal: (options) => {
      const terminal = new Terminal(options)
      // The real parser and viewport run without a canvas renderer.
      terminal.open = () => {}
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm supplies the document's narrower API; init supplies its required options.
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
  startTerminalDocument(documentScope)
  cleanups.push(() => stopTerminalDocument(documentScope))
  const terminal: TerminalWebViewHandle = {
    prepareForForegroundRecovery: vi.fn(),
    init(cols, rows, initialData, preserveScroll, oscLinks) {
      ready = new Promise((resolve) => {
        resolveReady = resolve
      })
      handleMsg(documentScope, {
        type: 'init',
        cols,
        rows,
        initialData,
        preserveScroll,
        oscLinks
      })
    },
    awaitReady: () => ready,
    measureFitDimensions: async () => ({ cols: 80, rows: 24 }),
    resetZoom: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    reflow: vi.fn(),
    clear: vi.fn(),
    cancelSelect: vi.fn(),
    doSelectAll: vi.fn()
  }
  let deliver: (event: unknown) => void = () => {
    throw new Error('No terminal subscription')
  }
  const terminalUnsubsRef = { current: new Map<string, () => void>() }
  const subscribeSeqRef = { current: new Map<string, number>() }
  const unsubscribeTerminal = (handle: string) => {
    terminalUnsubsRef.current.get(handle)?.()
    terminalUnsubsRef.current.delete(handle)
    subscribeSeqRef.current.set(handle, (subscribeSeqRef.current.get(handle) ?? 0) + 1)
  }
  const fields = {
    client: {
      subscribe: vi.fn((_method: string, _params: unknown, onData: (event: unknown) => void) => {
        deliver = onData
        return vi.fn()
      })
    },
    clientId: 'test-client',
    setTerminalModes: vi.fn(),
    terminalCwdRef: { current: new Map<string, string>() },
    viewportRef: { current: { cols: 80, rows: 24 } },
    viewportMeasuredRef: { current: true },
    terminalUnsubsRef,
    subscribingHandlesRef: { current: new Set<string>() },
    leaseOnlyHandlesRef: { current: new Set<string>() },
    initializedHandlesRef: { current: new Set<string>() },
    terminalDiagnosticsRef: { current: new MobileTerminalDiagnostics() },
    viewportResubscribeBudgetRef: { current: new TerminalViewportResubscribeBudget() },
    webReadyHandlesRef: { current: new Set(['term-1']) },
    subscribedDocumentsRef: { current: new Set(['term-1']) },
    activeHandleRef: { current: 'term-1' },
    subscribeSeqRef,
    layoutSeqRef: { current: new Map<string, number>() },
    terminalFrameHeightRef: { current: 600 },
    scheduleDelayedAction: vi.fn(),
    showToast: vi.fn(),
    markNativeChatInputLeaseReady: vi.fn(),
    showNativeChatRef: { current: false },
    getTerminalRef: () => terminal,
    unsubscribeTerminal,
    unsubscribeTerminalRef: { current: unsubscribeTerminal },
    measureViewportOnce: vi.fn(),
    signalTerminalInventoryRecovery: vi.fn()
  }
  let model: ReturnType<typeof useMobileSessionTerminalSubscription> | undefined
  function Probe() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fields supplies every member this hook reads; unrelated route state is intentionally absent.
    const scope = fields as unknown as MobileSessionTerminalSubscriptionFoundationModel
    const subscription = useMobileSessionTerminalSubscription(scope)
    useEffect(() => {
      model = subscription
    }, [subscription])
    return null
  }
  act(() => {
    const renderer = create(createElement(Probe))
    cleanups.push(() => act(() => renderer.unmount()))
  })
  if (!model) {
    throw new Error('Terminal subscription hook did not render')
  }
  const snapshot = Array.from({ length: 200 }, (_, index) => `LINE_${index}`).join('\r\n')
  const connStateRef: { current: ConnectionState } = { current: 'connected' }
  const scheduled: Array<() => void> = []
  return {
    ...fields,
    ...model,
    connStateRef,
    terminalRefs: { current: new Map([['term-1', terminal]]) },
    schedule: (action: () => void) => scheduled.push(action),
    runScheduled: () => {
      for (const action of scheduled.splice(0)) {
        action()
      }
    },
    replay: async (serialized: unknown = snapshot) => {
      deliver({ type: 'scrollback', cols: 80, rows: 24, serialized })
      await ready
    },
    scrollToLine: (line: number) => documentScope.term!.scrollToLine(line),
    buffer: () => documentScope.term!.buffer.active
  }
}
