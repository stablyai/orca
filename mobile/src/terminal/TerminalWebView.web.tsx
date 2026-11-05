import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { View } from 'react-native'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { TerminalWebViewHandle, TerminalWebViewProps } from './terminal-webview-contract'
import { TerminalWebViewEngineErrorOverlay } from './terminal-webview-engine-error-state'
import { TERMINAL_WEBVIEW_FRAME_STYLES } from './terminal-webview-frame-styles'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { mountTerminalWebDocument, type TerminalWebDocument } from './terminal-web-document-mount'
import { useTerminalWebViewController } from './use-terminal-webview-controller'

type Props = TerminalWebViewProps

function describeTerminalDocumentStartupError(error: unknown): string {
  return translate(
    'terminal.webView.documentStartFailed',
    'terminal document failed to start - {{message}}',
    {
      message: error instanceof Error ? error.message : String(error)
    }
  )
}

export type { TerminalWebViewHandle } from './terminal-webview-contract'

// react-native-webview has no rendered web implementation; mount the same document factory with the native controller contract.
export const TerminalWebView = forwardRef<TerminalWebViewHandle, Props>(
  function TerminalWebView(props, ref) {
    useMobileTranslation()
    const hostRef = useRef<View>(null)
    const documentRef = useRef<TerminalWebDocument | null>(null)
    // Readiness fires inside mount before a handle exists; buffer its synchronous controller flush until the handle returns.
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
      // The page has no separate content process; losing its modules also loses this component.
      pingsOnForegroundRecovery: () => false
    })
    const { clearEngineError, engineError, handle, receive, resetReadiness } = controller
    // Reload replaces the host div as well as the document so xterm cannot inherit the old mount.
    const [generation, setGeneration] = useState(0)
    // Seed shown/scale before document startup, matching native pre-content state.
    const [atMount] = useState(() => ({
      textScale: props.textScale ?? 1,
      shown: props.shownAtMount ?? true
    }))

    useImperativeHandle(ref, () => handle, [handle])
    // Commit the notify sink before mount; discarded renders must not mutate a callback’s live ref.
    useEffect(() => {
      receiveRef.current = receive
    }, [receive])
    useEffect(() => {
      // react-native-web renders View as a div and forwards the ref to it.
      const host = hostRef.current
      if (!(host instanceof HTMLElement)) {
        return
      }
      let live
      try {
        live = mountTerminalWebDocument(host, (message) => receiveRef.current?.(message), atMount)
      } catch (error) {
        // Startup failure has no handle or later error notify; report its cause now instead of waiting for readiness timeout.
        receiveRef.current?.({
          type: 'error',
          fatal: true,
          message: describeTerminalDocumentStartupError(error)
        })
        return
      }
      documentRef.current = live
      // Replay the pre-handle ready flush; theme/scale also ride init today, but future commands may not.
      for (const command of beforeMountRef.current) {
        live.send(command)
      }
      beforeMountRef.current = []
      return () => {
        documentRef.current = null
        live.dispose()
      }
      // Mount once per generation; callback-driven controller changes must not discard terminal scrollback.
    }, [atMount, generation])

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
        {/* onLayout makes react-native-web observe the box the document sizes to. */}
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
