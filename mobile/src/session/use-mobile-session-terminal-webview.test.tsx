import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import { deferFirstSubscribeUntilViewportMeasured } from './mobile-terminal-first-subscribe-viewport'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import type { MobileSessionTabSwitchingModel } from './use-mobile-session-tab-switching'
import { useMobileSessionTerminalWebview } from './use-mobile-session-terminal-webview'

const HANDLE = 'term-1'

function terminalHandle(): TerminalWebViewHandle {
  return {
    prepareForForegroundRecovery: vi.fn(),
    write: vi.fn(),
    init: vi.fn(),
    resize: vi.fn(),
    reflow: vi.fn(),
    clear: vi.fn(),
    measureFitDimensions: vi.fn(async () => null),
    resetZoom: vi.fn(),
    cancelSelect: vi.fn(),
    doSelectAll: vi.fn(),
    awaitReady: vi.fn(async () => {})
  }
}

function makeScope() {
  const fields = {
    markdownDocs: new Map(),
    fileDocs: new Map(),
    terminalGestureInputBucketsRef: { current: new Map() },
    terminalGestureInputQueuesRef: { current: new Map() },
    terminalGestureInputInFlightRef: { current: new Set() },
    terminalRefs: { current: new Map<string, TerminalWebViewHandle>() },
    terminalUnsubsRef: { current: new Map<string, () => void>() },
    initializedHandlesRef: { current: new Set<string>() },
    terminalDiagnosticsRef: { current: new MobileTerminalDiagnostics() },
    webReadyHandlesRef: { current: new Set<string>() },
    subscribedDocumentsRef: { current: new Set<string>() },
    activeHandleRef: { current: HANDLE },
    pendingActiveTerminalHandleRef: { current: null },
    activeSessionTab: null,
    unsubscribeTerminal: vi.fn(),
    subscribeToTerminal: vi.fn(),
    nativeChatStream: { notifyWebReady: vi.fn() },
    readMarkdownTab: vi.fn(),
    readFileTab: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook destructures only the fields built above.
  return { fields, scope: fields as unknown as MobileSessionTabSwitchingModel }
}

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

function renderWebviewHook(scope: MobileSessionTabSwitchingModel) {
  let model: ReturnType<typeof useMobileSessionTerminalWebview> | undefined
  function Probe() {
    model = useMobileSessionTerminalWebview(scope)
    return null
  }
  act(() => {
    renderer = create(createElement(Probe))
  })
  if (!model) {
    throw new Error('hook did not render')
  }
  return model
}

// The gate as subscribeToTerminal calls it once a refit has cleared the measured flag.
function gateWouldReopen(fields: ReturnType<typeof makeScope>['fields']) {
  return deferFirstSubscribeUntilViewportMeasured({
    handle: HANDLE,
    covered: false,
    viewportMeasured: false,
    subscribedDocuments: fields.subscribedDocumentsRef.current,
    subscribingHandles: new Set(),
    subscribeSeq: new Map([[HANDLE, 1]]),
    measure: vi.fn(async () => {}),
    subscribe: vi.fn()
  })
}

describe('terminal document lifetime for the first-subscribe gate', () => {
  it('keeps a live document marked when its handle re-attaches for a theme or text-size change', () => {
    const { fields, scope } = makeScope()
    const model = renderWebviewHook(scope)
    model.setTerminalWebViewRef(HANDLE, terminalHandle())
    model.handleTerminalWebReady(HANDLE)
    fields.subscribedDocumentsRef.current.add(HANDLE)
    // The controller's handle memo changes with theme and text scale: null, then the new handle.
    model.setTerminalWebViewRef(HANDLE, null)
    model.setTerminalWebViewRef(HANDLE, terminalHandle())
    expect(gateWouldReopen(fields)).toBe(false)
  })

  it('forgets the mark when a new document announces itself', () => {
    const { fields, scope } = makeScope()
    const model = renderWebviewHook(scope)
    model.setTerminalWebViewRef(HANDLE, terminalHandle())
    fields.subscribedDocumentsRef.current.add(HANDLE)
    model.handleTerminalWebReady(HANDLE)
    expect(fields.subscribedDocumentsRef.current.has(HANDLE)).toBe(false)
  })
})
