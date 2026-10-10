import { useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react'
import { Platform, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { TerminalWebViewHandle, TerminalWebViewProps } from './terminal-webview-contract'
import { useTerminalWebViewDocumentLifecycle } from './terminal-webview-document-lifecycle'
import { TerminalWebViewEngineErrorOverlay } from './terminal-webview-engine-error-state'
import { TERMINAL_WEBVIEW_FRAME_STYLES } from './terminal-webview-frame-styles'
import { xtermWebViewSource } from './terminal-webview-html'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { useTerminalWebViewController } from './use-terminal-webview-controller'

type Props = TerminalWebViewProps

export type { TerminalWebViewHandle } from './terminal-webview-contract'

// iOS can preserve the native view while discarding its JS/backing-store state.
const pingsOnForegroundRecovery = () => Platform.OS === 'ios'

export const TerminalWebView = forwardRef<TerminalWebViewHandle, Props>(
  function TerminalWebView(props, ref) {
    const webViewRef = useRef<WebView>(null)

    const post = useCallback((command: TerminalWebViewCommand & { id: number }) => {
      webViewRef.current?.postMessage(JSON.stringify(command))
    }, [])

    const {
      clearEngineError,
      engineError,
      handle,
      receive: receiveFromDocument,
      reportNativeEngineError,
      resetReadiness
    } = useTerminalWebViewController(props, { post, pingsOnForegroundRecovery })
    const { gatedHandle, hideSurface, invalidateDocument, receive, surfaceReady } =
      useTerminalWebViewDocumentLifecycle({
        handle,
        receive: receiveFromDocument,
        resetReadiness,
        pingsOnForegroundRecovery
      })

    useImperativeHandle(ref, () => gatedHandle, [gatedHandle])
    // Why: the document builds its terminal before ready, so it needs the text scale before any
    // message can reach it; later changes arrive as set-font-scale.
    // Why: in the page source rather than injected: Android can run an injected script after the
    // document's own, which then starts without them.
    const [source] = useState(() =>
      xtermWebViewSource({ textScale: props.textScale ?? 1, shown: props.shownAtMount ?? true })
    )

    const handleMessage = useCallback(
      (event: WebViewMessageEvent) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(event.nativeEvent.data) as Record<string, unknown>
        } catch {
          return
        }
        receive(msg)
      },
      [receive]
    )

    const handleReload = useCallback(() => {
      // Why: reload discards the backing store before onLoadStart can hide it.
      hideSurface()
      clearEngineError()
      webViewRef.current?.reload()
    }, [clearEngineError, hideSurface])

    const handleContentProcessDidTerminate = useCallback(() => {
      // Why: WKWebView content-process loss is recoverable; stale commands belong
      // to the dead document and the replacement must prove readiness before replay.
      invalidateDocument()
      clearEngineError()
      webViewRef.current?.reload()
    }, [clearEngineError, invalidateDocument])

    return (
      <View style={[TERMINAL_WEBVIEW_FRAME_STYLES.container, props.style]}>
        <WebView
          ref={webViewRef}
          source={source}
          style={[
            TERMINAL_WEBVIEW_FRAME_STYLES.webview,
            !surfaceReady && TERMINAL_WEBVIEW_FRAME_STYLES.webviewHidden
          ]}
          originWhitelist={['*']}
          javaScriptEnabled
          scrollEnabled={false}
          // Why: Android parent gesture containers can intercept vertical drags
          // before the injected xterm scroll router sees them.
          nestedScrollEnabled
          scalesPageToFit={false}
          // Why: Android WebView defaults textZoom to the system font scale, inflating
          // xterm's DOM glyphs past its canvas-measured cell grid (#4579). iOS ignores it.
          textZoom={100}
          onLoadStart={invalidateDocument}
          onMessage={handleMessage}
          onError={(event) => reportNativeEngineError('Terminal WebView load failed', event)}
          onHttpError={(event) => reportNativeEngineError('Terminal WebView HTTP error', event)}
          onRenderProcessGone={(event) =>
            reportNativeEngineError('Terminal WebView render process ended', event)
          }
          onContentProcessDidTerminate={handleContentProcessDidTerminate}
        />
        {engineError ? (
          <TerminalWebViewEngineErrorOverlay message={engineError} onReload={handleReload} />
        ) : null}
      </View>
    )
  }
)
