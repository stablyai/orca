// @vitest-environment happy-dom
import { createElement, useState } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { createTerminalDocument } from '../terminal/document/create-terminal-document'
import { terminalDocumentDouble } from '../terminal/document/document-terminal-double.test-support'
import { TERMINAL_DOCUMENT_MARKUP } from '../terminal/terminal-webview-html'
import { dispatchTerminalWebViewNotification } from '../terminal/terminal-webview-notification-dispatch'
import { terminalPaneViewport, type TerminalPaneViewport } from './mobile-terminal-pane-layout'
import { useMobileSessionTerminalWebview } from './use-mobile-session-terminal-webview'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'
import { useMobileSessionTabSwitching } from './use-mobile-session-tab-switching'

vi.mock('../platform/haptics', () => ({ triggerSelection: vi.fn() }))

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function fireTouch(surface: HTMLElement, type: string, y?: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: y === undefined ? [] : [{ identifier: 0, clientX: 40, clientY: y, target: surface }]
  })
  surface.dispatchEvent(event)
}

it.each(['touch', 'wheel', 'mouse', 'tap'] as const)(
  '%s selects either split pane before its first input; only a touch tap opens the keyboard',
  async (gesture) => {
    vi.useFakeTimers()
    const activeHandleRef = { current: 'a' }
    const visibleTerminalHandlesRef = { current: ['a', 'b'] }
    const subscriptions = {
      current: new Map([
        ['a', vi.fn()],
        ['b', vi.fn()]
      ])
    }
    const geometry = { current: new Map<string, TerminalPaneViewport>() }
    const focus = vi.fn()
    const unsubscribe = vi.fn()
    const send = vi.fn(async (_handle: string, _bytes: string) => true)
    const request = vi.fn(async (_method: string, _params?: unknown) => ({
      id: 'test',
      ok: true as const,
      result: { send: { accepted: true } }
    }))
    const client = { sendRequest: request }
    const modes = {
      bracketedPasteMode: false,
      altScreen: true,
      mouseTrackingMode: 'none' as const,
      sgrMouseMode: false,
      sgrMousePixelsMode: false,
      applicationCursorKeysMode: false,
      kittyKeyboardFlags: 0,
      modifyOtherKeys: 0
    }
    const pointerModes = { ...modes, mouseTrackingMode: 'vt200' as const, sgrMouseMode: true }
    const liveHandles = { current: new Set<string>() }
    let receive!: (handle: string, message: Record<string, unknown>) => void
    let tap!: (handle: string) => void
    function Probe() {
      const [activeHandle, setActiveHandle] = useState<string | null>('a')
      const scope = mountFixture<Parameters<typeof useMobileSessionTabSwitching>[0]>({
        activeHandle,
        setActiveHandle,
        activeHandleRef,
        visibleTerminalHandlesRef,
        visibleTerminalHandles: ['a', 'b'],
        terminalUnsubsRef: subscriptions,
        terminalPaneViewportsRef: geometry,
        getTerminalPaneViewport: (handle) => terminalPaneViewport(geometry.current, handle),
        terminals: ['a', 'b'].map((handle) => ({
          handle,
          title: handle,
          isActive: handle === activeHandle
        })),
        sessionTabs: ['a', 'b'].map((handle) => ({
          id: handle,
          type: 'terminal',
          terminal: handle
        })),
        activeSessionTabTypeRef: { current: 'terminal' },
        setActiveSessionTabId: vi.fn(),
        pendingSelectionRef: { current: null },
        terminalDiagnosticsRef: { current: { tabSwitch: vi.fn() } },
        defaultTerminalHandlesToLiveInput: vi.fn(),
        switchSessionTabRef: { current: null },
        connState: 'connected',
        connStateRef: { current: 'connected' },
        client,
        clientRef: { current: client },
        deviceTokenRef: { current: 'test-device' },
        handleTerminalTap: focus,
        subscribeToTerminal: vi.fn(),
        unsubscribeTerminal: unsubscribe,
        activeSessionTab: null,
        markdownDocs: new Map(),
        fileDocs: new Map(),
        ptyModesRef: {
          current: new Map(
            ['a', 'b'].map((handle) => [
              handle,
              gesture === 'mouse' || gesture === 'tap' ? pointerModes : modes
            ])
          )
        },
        terminalGestureInputBucketsRef: { current: new Map() },
        terminalGestureInputQueuesRef: { current: new Map() },
        terminalGestureInputInFlightRef: { current: new Set() },
        liveInputTerminalHandlesRef: liveHandles,
        sendLiveTerminalInputRef: { current: send }
      })
      const switching = useMobileSessionTabSwitching(scope)
      const webview = useMobileSessionTerminalWebview(Object.assign(scope, switching))
      const input = useMobileSessionTerminalInput(
        mountFixture(Object.assign(scope, switching, webview))
      )
      tap = webview.handleTerminalTap
      receive = (handle, message) =>
        dispatchTerminalWebViewNotification(message, {
          reportEngineError: (error) => {
            throw new Error(error)
          },
          onTerminalInteraction: () => webview.handleTerminalInteraction?.(handle),
          onTerminalTap: () => webview.handleTerminalTap(handle),
          onTerminalInput: (bytes, pointer) => input.handleTerminalInput(handle, bytes, pointer)
        })
      return null
    }
    let renderer!: ReturnType<typeof create>
    const docs: ReturnType<typeof createTerminalDocument>[] = []
    const surfaces = new Map<string, HTMLElement>()
    const opened = vi.fn()
    try {
      act(() => {
        renderer = create(createElement(Probe))
      })
      for (const handle of ['a', 'b']) {
        const host = document.createElement('div')
        host.innerHTML = TERMINAL_DOCUMENT_MARKUP
        document.body.appendChild(host)
        const engine = terminalDocumentDouble()
        const started = createTerminalDocument({
          root: host,
          postToHost: (message) => receive(handle, message),
          hasEngine: () => true,
          installHostTransport: () => () => {},
          installErrorReporter: () => () => {},
          paintDocumentBackground: () => {},
          viewportRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
          observeViewport: () => () => {},
          createUnicode11Addon: () => null,
          createWebglAddon: () => null,
          createTerminal: () => ({
            ...engine.terminal,
            modes: gesture === 'mouse' || gesture === 'tap' ? pointerModes : modes,
            _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 15 } } } } },
            buffer: { active: { ...engine.terminal.buffer.active, type: 'alternate' } },
            open: (surface) => {
              engine.terminal.open(surface)
              opened(handle)
            }
          })
        })
        docs.push(started)
        started.send({ type: 'init', cols: 40, rows: 24, initialData: '' })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(150)
        })
        if (gesture === 'mouse' || gesture === 'tap') {
          started.send({ type: 'write', data: '\x1b[?1000h\x1b[?1006h' })
        }
        const surface = host.querySelector<HTMLElement>('#terminal-surface')
        if (!surface) {
          throw new Error('No terminal surface')
        }
        surfaces.set(handle, surface)
      }
      const openedBefore = opened.mock.calls.length
      request.mockClear()
      for (const handle of ['b', 'a']) {
        const surface = surfaces.get(handle)!
        await act(async () => {
          if (gesture === 'tap') {
            fireTouch(surface, 'touchstart', 150)
            fireTouch(surface, 'touchend')
          } else if (gesture === 'touch') {
            fireTouch(surface, 'touchstart', 150)
            fireTouch(surface, 'touchmove', 90)
            fireTouch(surface, 'touchcancel')
          } else if (gesture === 'wheel') {
            surface.dispatchEvent(
              new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                deltaY: 60,
                clientX: 40,
                clientY: 150
              })
            )
          } else {
            surface.dispatchEvent(
              new PointerEvent('pointerdown', {
                bubbles: true,
                pointerType: 'mouse',
                button: 0,
                clientX: 40,
                clientY: 150
              })
            )
            surface.dispatchEvent(
              new PointerEvent('pointerup', {
                bubbles: true,
                pointerType: 'mouse',
                button: 0,
                clientX: 40,
                clientY: 150
              })
            )
          }
        })
        expect(activeHandleRef.current).toBe(handle)
        if (gesture === 'mouse' || gesture === 'tap') {
          expect(send.mock.calls.at(-1)).toEqual([
            handle,
            expect.stringContaining('\x1b[<0;'),
            'pointer'
          ])
        } else {
          expect(request).toHaveBeenCalledWith(
            'terminal.send',
            expect.objectContaining({ terminal: handle, text: '\x1b[B'.repeat(4) }),
            expect.anything()
          )
        }
      }
      if (gesture === 'wheel') {
        const a = surfaces.get('a')!
        const b = surfaces.get('b')!
        const wheel = (deltaY: number) =>
          a.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY,
              clientX: 40,
              clientY: 150
            })
          )
        await act(async () => {
          fireTouch(b, 'touchstart', 150)
          fireTouch(b, 'touchcancel')
        })
        const sentBeforeTail = request.mock.calls.filter(
          ([method]) => method === 'terminal.send'
        ).length
        await act(async () => {
          wheel(7)
        })
        expect(activeHandleRef.current).toBe('b')
        await act(async () => {
          wheel(30)
        })
        expect(activeHandleRef.current).toBe('b')
        expect(request.mock.calls.filter(([method]) => method === 'terminal.send')).toHaveLength(
          sentBeforeTail
        )
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250)
          wheel(8)
        })
        expect(activeHandleRef.current).toBe('a')
        expect(request.mock.calls.filter(([method]) => method === 'terminal.send')).toHaveLength(
          sentBeforeTail
        )
        await act(async () => {
          wheel(7)
        })
        expect(request).toHaveBeenLastCalledWith(
          'terminal.send',
          expect.objectContaining({ terminal: 'a', text: '\x1b[B' }),
          expect.anything()
        )
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      if (gesture === 'tap') {
        expect(focus).toHaveBeenCalledWith('a')
      } else {
        expect(focus).not.toHaveBeenCalled()
      }
      focus.mockClear()
      expect(unsubscribe).not.toHaveBeenCalled()
      expect(visibleTerminalHandlesRef.current).toEqual(['a', 'b'])
      expect(opened.mock.calls).toHaveLength(openedBefore)
      act(() => {
        tap('b')
        receive('a', { type: 'terminal-interaction' })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      expect(focus).not.toHaveBeenCalled()
      const inputCount = request.mock.calls.filter(([method]) => method === 'terminal.send').length
      receive('b', { type: 'terminal-input', bytes: '\x1b[B' })
      expect(request.mock.calls.filter(([method]) => method === 'terminal.send')).toHaveLength(
        inputCount
      )
      receive('hidden', { type: 'terminal-interaction' })
      expect(activeHandleRef.current).toBe('a')
    } finally {
      for (const doc of docs) {
        doc.stop()
      }
      act(() => renderer?.unmount())
    }
  }
)
