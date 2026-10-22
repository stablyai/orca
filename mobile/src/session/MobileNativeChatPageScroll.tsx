import type { Ref } from 'react'
import { ScrollView, StyleSheet, View, type ScrollViewProps, type ViewStyle } from 'react-native'

/** The page's scroller, anchored at its end: scrollTop is 0 at the newest message and negative above
 *  it, so rows added above the reader never move what they read and the end needs no pin. The
 *  browser's scroll anchoring is off: the list keeps a parked reader's place itself. */
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
