import { memo, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { buildNativeChatVisualDocument } from '../../../src/shared/native-chat-visual-shell'
import type { MobileNativeChatVisualHostMode } from './mobile-native-chat-visual-host-document'
import { MOBILE_NATIVE_CHAT_VISUAL_THEME } from './mobile-native-chat-visual-theme'

export type MobileNativeChatVisualFrameProps = {
  html: string
  title: string
  mode: MobileNativeChatVisualHostMode
  onFailed: () => void
}

// Sealed frames run no script to report height; use an internally scrolling fixed-height frame.
const SEALED_INLINE_HEIGHT = 320

// srcdoc inherits shell CSP, so keep visuals static and sandboxed with opaque origin; enabling inline scripts would weaken page policy.
export const MobileNativeChatVisualFrame = memo(function MobileNativeChatVisualFrame({
  html,
  title,
  mode
}: MobileNativeChatVisualFrameProps) {
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

// Use DOM styles because this is an iframe, not a React Native view.
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
