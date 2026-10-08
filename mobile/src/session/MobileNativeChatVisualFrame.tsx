import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes'
import * as ExpoCrypto from 'expo-crypto'
import { buildNativeChatVisualDocument } from '../../../src/shared/native-chat-visual-shell'
import { createNativeChatVisualHeightGovernor } from '../../../src/shared/native-chat-visual-height-governor'
import { openExternalLink } from '../platform/external-link'
import {
  MOBILE_NATIVE_CHAT_VISUAL_LINK_INTERVAL_MS,
  readMobileNativeChatVisualBridgeMessage
} from './mobile-native-chat-visual-bridge'
import {
  buildMobileNativeChatVisualHostDocument,
  MOBILE_NATIVE_CHAT_VISUAL_APPLY_HEIGHT,
  MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT,
  type MobileNativeChatVisualHostMode
} from './mobile-native-chat-visual-host-document'
import { MOBILE_NATIVE_CHAT_VISUAL_THEME } from './mobile-native-chat-visual-theme'

export type MobileNativeChatVisualFrameProps = {
  html: string
  title: string
  mode: MobileNativeChatVisualHostMode
  /** The frame cannot show this visual (it navigated away, or its web process keeps dying). */
  onFailed: () => void
}

/** One automatic reload after the web process dies; a page that kills it again is unavailable. */
const MAX_PROCESS_RESTARTS = 1

function randomHex(): string {
  return Array.from(ExpoCrypto.getRandomBytes(16), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

// Only the host document and its srcdoc child load, plus in-page anchors within them. A visual's
// links reach the app through the bridge instead, so every other navigation is refused, not opened.
function allowsLoad(request: ShouldStartLoadRequest): boolean {
  const url = request.url.split('#', 1)[0]
  return url === 'about:blank' || url === 'about:srcdoc'
}

/**
 * One visual in a WebView: a trusted host document with the author HTML in an opaque sandboxed
 * child (see `buildMobileNativeChatVisualHostDocument`). The app accepts exactly two requests from
 * it, each token- and channel-checked here: a height, which the shared governor turns into the
 * frame's height, and an http(s) link to open.
 */
export const MobileNativeChatVisualFrame = memo(function MobileNativeChatVisualFrame({
  html,
  title,
  mode,
  onFailed
}: MobileNativeChatVisualFrameProps) {
  const webView = useRef<WebView>(null)
  const [token] = useState(randomHex)
  const [generation, setGeneration] = useState(0)
  const [height, setHeight] = useState(MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT)
  const restarts = useRef(0)
  const lastLinkAt = useRef(-Infinity)

  const built = useMemo(() => {
    const channel = randomHex()
    const visualDocument = buildNativeChatVisualDocument({
      html,
      channel,
      theme: MOBILE_NATIVE_CHAT_VISUAL_THEME
    })
    return {
      channel,
      source: {
        html: buildMobileNativeChatVisualHostDocument({
          visualDocument,
          channel,
          token,
          title,
          mode
        })
      }
    }
  }, [html, token, title, mode])

  // A fresh governor per loaded document; reports queue behind a deferral rather than pile up.
  const sizing = useRef<{
    governor: ReturnType<typeof createNativeChatVisualHeightGovernor>
    latest: number | null
    deferred: ReturnType<typeof setTimeout> | null
  }>({ governor: createNativeChatVisualHeightGovernor(), latest: null, deferred: null })
  useEffect(() => {
    const state = sizing.current
    state.governor = createNativeChatVisualHeightGovernor()
    state.latest = null
    return () => {
      if (state.deferred) {
        clearTimeout(state.deferred)
        state.deferred = null
      }
    }
  }, [built, generation])

  const applyHeight = useCallback(() => {
    const state = sizing.current
    state.deferred = null
    if (state.latest === null) {
      return
    }
    const decision = state.governor.decide(state.latest, Date.now())
    if (decision.kind === 'apply') {
      setHeight(decision.height)
      webView.current?.injectJavaScript(
        `window.${MOBILE_NATIVE_CHAT_VISUAL_APPLY_HEIGHT}(${decision.height}); true;`
      )
    } else if (decision.kind === 'defer') {
      state.deferred = setTimeout(applyHeight, decision.retryInMs)
    }
  }, [])

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = readMobileNativeChatVisualBridgeMessage(
        event.nativeEvent.data,
        token,
        built.channel
      )
      if (!message) {
        return
      }
      if (message.kind === 'escaped') {
        onFailed()
        return
      }
      if (message.kind === 'size') {
        if (mode === 'inline') {
          sizing.current.latest = message.height
          if (!sizing.current.deferred) {
            applyHeight()
          }
        }
        return
      }
      const now = Date.now()
      if (now - lastLinkAt.current < MOBILE_NATIVE_CHAT_VISUAL_LINK_INTERVAL_MS) {
        return
      }
      lastLinkAt.current = now
      openExternalLink(message.url)
    },
    [token, built.channel, mode, applyHeight, onFailed]
  )

  const restart = useCallback(() => {
    if (restarts.current >= MAX_PROCESS_RESTARTS) {
      onFailed()
      return
    }
    restarts.current += 1
    setHeight(MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT)
    setGeneration((value) => value + 1)
  }, [onFailed])

  return (
    <WebView
      key={generation}
      ref={webView}
      source={built.source}
      style={mode === 'inline' ? [styles.inline, { height }] : styles.fullscreen}
      accessibilityLabel={title}
      // '*' so every navigation reaches `allowsLoad`: an origin outside this list is opened in the
      // system browser by the WebView library itself, with no gesture check.
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={allowsLoad}
      javaScriptEnabled
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false}
      domStorageEnabled={false}
      allowFileAccess={false}
      allowsLinkPreview={false}
      mediaCapturePermissionGrantType="deny"
      mixedContentMode="never"
      // Android scales WebView text by the system font size; the page lays itself out.
      textZoom={100}
      scrollEnabled={false}
      bounces={false}
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
      onMessage={onMessage}
      onError={onFailed}
      onHttpError={onFailed}
      onContentProcessDidTerminate={restart}
      onRenderProcessGone={restart}
    />
  )
})

const styles = StyleSheet.create({
  inline: { width: '100%', backgroundColor: 'transparent' },
  fullscreen: { flex: 1, backgroundColor: 'transparent' }
})
