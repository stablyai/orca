import { memo, useEffect, useMemo, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  buildNativeChatVisualDocument,
  nativeChatVisualThemeMessage,
  newNativeChatVisualChannel
} from '../../../../../src/shared/native-chat/visuals/native-chat-visual-shell'
import type { MobileNativeChatVisualHostMode } from './mobile-native-chat-visual-host-document'
import { MOBILE_NATIVE_CHAT_VISUAL_THEME } from './mobile-native-chat-visual-theme'
import {
  MOBILE_NATIVE_CHAT_VISUAL_FRAME_PATH,
  mobileNativeChatVisualDocumentMessage
} from './mobile-native-chat-visual-frame-contract'
import { useMobileNativeChatVisualFrameGrant } from './use-mobile-native-chat-visual-frame-grant'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'

export type MobileNativeChatVisualFrameProps = {
  html: string
  title: string
  mode: MobileNativeChatVisualHostMode
  onFailed: () => void
}

// Frames keep a fixed inline height and scroll inside; they are not fitted to the visual.
const INLINE_HEIGHT = 320

export const MobileNativeChatVisualFrame = memo(function MobileNativeChatVisualFrame({
  html,
  title,
  mode
}: MobileNativeChatVisualFrameProps) {
  const scripted = useMobileNativeChatVisualFrameGrant()
  return (
    <View style={mode === 'inline' ? styles.inline : styles.fullscreen}>
      {scripted ? (
        <ScriptedVisualFrame html={html} title={title} />
      ) : (
        <SealedVisualFrame html={html} title={title} />
      )}
    </View>
  )
})

// The shell's frame document has its own opaque origin and policy, so author scripts never run under the page's.
function ScriptedVisualFrame({ html, title }: { html: string; title: string }) {
  const colorScheme = useMobileColorScheme()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const loadedRef = useRef(false)
  // One channel per visual; the document is built at handoff so it paints in the current theme.
  const channel = useMemo(() => newNativeChatVisualChannel(), [html])

  useEffect(() => {
    if (loadedRef.current) {
      frameRef.current?.contentWindow?.postMessage(
        nativeChatVisualThemeMessage(MOBILE_NATIVE_CHAT_VISUAL_THEME, channel),
        '*'
      )
    }
  }, [channel, colorScheme])

  return (
    <iframe
      key={channel}
      ref={frameRef}
      title={title}
      src={MOBILE_NATIVE_CHAT_VISUAL_FRAME_PATH}
      // Never allow-same-origin: the opaque origin keeps the visual away from the page's.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      style={IFRAME_STYLE}
      onLoad={() => {
        loadedRef.current = true
        const document = buildNativeChatVisualDocument({
          html,
          channel,
          theme: MOBILE_NATIVE_CHAT_VISUAL_THEME
        })
        frameRef.current?.contentWindow?.postMessage(
          mobileNativeChatVisualDocumentMessage(document, title),
          '*'
        )
      }}
    />
  )
}

// srcdoc inherits the shell CSP, so older shells keep visuals static and sandboxed with an opaque origin.
function SealedVisualFrame({ html, title }: { html: string; title: string }) {
  const colorScheme = useMobileColorScheme()
  const document = useMemo(
    () =>
      buildNativeChatVisualDocument({
        html,
        channel: 'sealed',
        theme: MOBILE_NATIVE_CHAT_VISUAL_THEME
      }),
    // Sealed frames run no script, so a scheme rebuild loses no state.
    [html, colorScheme]
  )
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={document}
      referrerPolicy="no-referrer"
      style={IFRAME_STYLE}
    />
  )
}

// Use DOM styles because this is an iframe, not a React Native view.
const IFRAME_STYLE = {
  border: 'none',
  width: '100%',
  height: '100%',
  backgroundColor: 'transparent'
} as const

const styles = StyleSheet.create({
  inline: { width: '100%', height: INLINE_HEIGHT },
  fullscreen: { flex: 1 }
})
