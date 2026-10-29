import { useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react'
import { Platform, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { TerminalWebViewHandle, TerminalWebViewProps } from './terminal-webview-contract'
import { TerminalWebViewEngineErrorOverlay } from './terminal-webview-engine-error-state'
import { TERMINAL_WEBVIEW_FRAME_STYLES } from './terminal-webview-frame-styles'
import { xtermWebViewSource } from './terminal-webview-html'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { useTerminalWebViewController } from './use-terminal-webview-controller'

type Props = TerminalWebViewProps

export type { TerminalWebViewHandle } from './terminal-webview-contract'

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
      receive,
      reportNativeEngineError,
      resetReadiness
    } = useTerminalWebViewController(props, {
      post,
      // iOS can preserve the native view while discarding its JS/backing-store state.
      pingsOnForegroundRecovery: () => Platform.OS === 'ios'
    })

    useImperativeHandle(ref, () => handle, [handle])
    // Seed scale in page source before document startup; Android injected scripts may run too late.
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
      clearEngineError()
      webViewRef.current?.reload()
    }, [clearEngineError])

    const handleContentProcessDidTerminate = useCallback(() => {
      // Content-process recovery must discard dead-document commands and prove new readiness before replay.
      resetReadiness()
      clearEngineError()
      webViewRef.current?.reload()
    }, [clearEngineError, resetReadiness])

    return (
      <View style={[TERMINAL_WEBVIEW_FRAME_STYLES.container, props.style]}>
        <WebView
          ref={webViewRef}
          source={source}
          style={TERMINAL_WEBVIEW_FRAME_STYLES.webview}
          originWhitelist={['*']}
          javaScriptEnabled
          scrollEnabled={false}
          // Prevent Android parent gestures from intercepting drags before xterm sees them.
          nestedScrollEnabled
          scalesPageToFit={false}
          // Fix Android textZoom at 100 so OS font scaling cannot exceed xterm’s canvas-measured grid.
          textZoom={100}
          onLoadStart={resetReadiness}
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
