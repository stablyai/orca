import type { Ref } from 'react'
import { ScrollView, StyleSheet, View, type ScrollViewProps, type ViewStyle } from 'react-native'

// Reverse anchoring gives scrollTop=0 at the tail and negative offsets above; disable browser anchoring because the list restores parked readers itself.
export function MobileNativeChatPageScroll({
  ref,
  children,
  contentContainerStyle,
  ...props
}: ScrollViewProps & { ref?: Ref<ScrollView> }) {
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
const endAnchored: ViewStyle & { overflowAnchor: 'none' } = {
  flexDirection: 'column-reverse',
  overflowAnchor: 'none'
}

const pageScroll = StyleSheet.create({
  endAnchored,
  // A short chat still fills the screen from the top.
  content: { flexGrow: 1, flexShrink: 0 }
})
