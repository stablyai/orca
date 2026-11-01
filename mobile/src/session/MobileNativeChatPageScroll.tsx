import type { Ref } from 'react'
import { ScrollView, View, type ScrollViewProps, type ViewStyle } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Reverse anchoring gives scrollTop=0 at the tail and negative offsets above; disable browser anchoring because the list restores parked readers itself.
export function MobileNativeChatPageScroll({
  ref,
  children,
  contentContainerStyle,
  ...props
}: ScrollViewProps & { ref?: Ref<ScrollView> }) {
  useMobileColorScheme()
  return (
    <ScrollView
      ref={ref}
      {...props}
      style={pageScroll.endAnchored}
      contentContainerStyle={pageScroll.content}
    >
      <View style={contentContainerStyle}>{children}</View>
    </ScrollView>
  )
}

// RN Web passes it through to CSS; ViewStyle doesn't name it.
type EndAnchored = ViewStyle & { overflowAnchor: 'none' }

const pageScroll = themedStyleSheet(() => {
  const endAnchored: EndAnchored = {
    flexDirection: 'column-reverse',
    overflowAnchor: 'none',
    // Opaque scroller layer: some Android GPUs draw its transparent pixels black during selection (#36553).
    backgroundColor: colors.bgBase
  }
  return {
    endAnchored,
    // A short chat still fills the screen from the top.
    content: { flexGrow: 1, flexShrink: 0 }
  }
})
