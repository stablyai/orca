import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { View } from 'react-native'
import type { TerminalWebViewHandle, TerminalWebViewProps } from './terminal-webview-contract'
import { TerminalWebViewEngineErrorOverlay } from './terminal-webview-engine-error-state'
import { TERMINAL_WEBVIEW_FRAME_STYLES } from './terminal-webview-frame-styles'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { mountTerminalWebDocument, type TerminalWebDocument } from './terminal-web-document-mount'
import { useTerminalWebViewController } from './use-terminal-webview-controller'

type Props = TerminalWebViewProps

export type { TerminalWebViewHandle } from './terminal-webview-contract'

/**
 * The same terminal, with the WebView taken out.
 *
 * `react-native-webview` has no web build that renders anything: on the page it paints the line
 * "React Native WebView does not support this platform" where the terminal was. So the page mounts
 * the document itself — xterm as an import, the document as the factory the WebView's own script is
 * generated from — and keeps the contract above it exactly as it was. `TerminalPaneView` and the subscription foundation hold
 * `TerminalWebViewProps` and `TerminalWebViewHandle` and cannot tell which of the two they have.
 *
 * Both halves of the transport are the same objects the native component uses: the commands are
 * `TerminalWebViewCommand`, handed to the document's own `handleMsg` instead of across a bridge,
 * and every notify goes back through the controller's `receive`, which is the same dispatch.
 */
export const TerminalWebView = forwardRef<TerminalWebViewHandle, Props>(
  function TerminalWebView(props, ref) {
    const hostRef = useRef<View>(null)
    const documentRef = useRef<TerminalWebDocument | null>(null)
    // The document reports itself ready from inside the mount call, through the seam below, so the
    // controller flushes its queue while this effect is still on the line that built the document
    // and `documentRef` is null. That flush is the one caller that reaches `post` before the mount
    // has a handle, and this is what catches it: held here, replayed the moment there is one.
    const beforeMountRef = useRef<(TerminalWebViewCommand & { id: number })[]>([])
    const receiveRef = useRef<((message: Record<string, unknown>) => void) | null>(null)

    const post = useCallback((command: TerminalWebViewCommand & { id: number }) => {
      const mounted = documentRef.current
      if (mounted) {
        mounted.send(command)
        return
      }
      beforeMountRef.current.push(command)
    }, [])

    const controller = useTerminalWebViewController(props, {
      post,
      // No second content process to lose: the document is this page's own modules, and if they
      // were gone so was the component holding this handle.
      pingsOnForegroundRecovery: () => false
    })
    const { clearEngineError, engineError, handle, receive, resetReadiness } = controller
    // The page's answer to the WebView's reload: drop the document and build another one. The host
    // element is keyed on it so React replaces the div rather than handing back one xterm left in.
    const [generation, setGeneration] = useState(0)

    useImperativeHandle(ref, () => handle, [handle])
    // In an effect, not during render: React may replay or discard render work, and the document
    // reads this ref from a callback that outlives the render that mounted it. The mount effect
    // below is declared after this one, so the first read already sees a sink.
    useEffect(() => {
      receiveRef.current = receive
    }, [receive])

    useEffect(() => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: react-native-web renders View as a div and forwards the ref to it; this module only ever runs in that build.
      const host = hostRef.current as unknown as HTMLElement | null
      if (!host) {
        return
      }
      let live
      try {
        live = mountTerminalWebDocument(host, (message) => receiveRef.current?.(message))
      } catch (error) {
        // A start that throws is the document's own failure and the factory has already unwound
        // it, so there is no handle and no engine ran: no `error` notify is coming. It goes down
        // the document's own reporting path, which names the cause in the overlay instead of
        // leaving the readiness watchdog to say "no ready after 15s".
        receiveRef.current?.({
          type: 'error',
          fatal: true,
          message: `terminal document failed to start - ${
            error instanceof Error ? error.message : String(error)
          }`
        })
        return
      }
      documentRef.current = live
      // Posted by the flush that readiness triggered, one line above this, before there was a
      // handle to send them through. Everything the queue can hold here is also carried by the
      // `init` that follows — the theme and the text scale — so dropping the replay is invisible
      // rather than harmless: the next command that is not re-sent would go missing silently.
      for (const command of beforeMountRef.current) {
        live.send(command)
      }
      beforeMountRef.current = []
      return () => {
        documentRef.current = null
        live.dispose()
      }
      // Mounted once per generation: re-running this would throw away a live terminal and its
      // scrollback, and the controller's identity changes with every callback prop.
    }, [generation])

    const handleHostLayout = useCallback(() => {
      documentRef.current?.notifyViewport()
    }, [])

    const handleReload = useCallback(() => {
      clearEngineError()
      resetReadiness()
      beforeMountRef.current = []
      setGeneration((previous) => previous + 1)
    }, [clearEngineError, resetReadiness])

    return (
      <View style={[TERMINAL_WEBVIEW_FRAME_STYLES.container, props.style]}>
        {/* Why: mounted with onLayout, so react-native-web observes it; the document sizes to this box. */}
        <View
          key={generation}
          ref={hostRef}
          style={TERMINAL_WEBVIEW_FRAME_STYLES.webview}
          onLayout={handleHostLayout}
        />
        {engineError ? (
          <TerminalWebViewEngineErrorOverlay message={engineError} onReload={handleReload} />
        ) : null}
      </View>
    )
  }
)
