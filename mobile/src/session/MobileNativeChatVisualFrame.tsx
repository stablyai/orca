import { memo, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { buildNativeChatVisualDocument } from '../../../src/shared/native-chat-visual-shell'
import type { MobileNativeChatVisualHostMode } from './mobile-native-chat-visual-host-document'
import { MOBILE_NATIVE_CHAT_VISUAL_THEME } from './mobile-native-chat-visual-theme'

export type MobileNativeChatVisualFrameProps = {
  html: string
  title: string
  mode: MobileNativeChatVisualHostMode
  /** The frame cannot show this visual (it navigated away, or its web process keeps dying). */
  onFailed: () => void
}

/** No script runs, so nothing reports a height; a fixed frame the visual scrolls inside. */
const SEALED_INLINE_HEIGHT = 320

/**
 * Inside the hybrid shell's page: the visual rendered sealed, with no script.
 *
 * The page is served under the shell's response-header policy (`script-src 'self'`,
 * `frame-src 'none'`), and a `srcdoc` frame inherits that policy, so a visual's inline scripts
 * cannot run here without loosening the page's own policy. Static markup, CSS and images still
 * render; script-drawn charts do not. An empty `sandbox` keeps the frame an opaque origin that runs
 * nothing and navigates nothing, as the page's HTML preview does.
 */
export const MobileNativeChatVisualFrame = memo(function MobileNativeChatVisualFrame({
  html,
  title,
  mode
}: MobileNativeChatVisualFrameProps) {
  // No script runs in this frame, so nothing ever reports on this channel.
  const document = useMemo(
    () =>
      buildNativeChatVisualDocument({
        html,
        channel: 'sealed',
        theme: MOBILE_NATIVE_CHAT_VISUAL_THEME
      }),
    [html]
  )
  return (
    <View style={mode === 'inline' ? styles.inline : styles.fullscreen}>
      <iframe
        title={title}
        sandbox=""
        srcDoc={document}
        referrerPolicy="no-referrer"
        style={IFRAME_STYLE}
      />
    </View>
  )
})

/** A DOM style, not a `StyleSheet` entry: this element is an `iframe` and not a react-native view. */
const IFRAME_STYLE = {
  border: 'none',
  width: '100%',
  height: '100%',
  backgroundColor: 'transparent'
} as const

const styles = StyleSheet.create({
  inline: { width: '100%', height: SEALED_INLINE_HEIGHT },
  fullscreen: { flex: 1 }
})
