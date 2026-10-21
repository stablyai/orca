import type { Ref } from 'react'
import { ScrollView, StyleSheet, View, type ScrollViewProps, type ViewStyle } from 'react-native'

/** The page's scroller. Where the browser has scroll anchoring it keeps a parked reader's place;
 *  the page turns it off on the scroller itself while it owns the scroll (following, a place-hold). */
export function MobileNativeChatPageScroll({
  ref,
  children,
  contentContainerStyle,
  ...props
}: ScrollViewProps & { ref?: Ref<ScrollView> }) {
  return (
    <ScrollView ref={ref} {...props} contentContainerStyle={pageScroll.fill}>
      <View style={contentContainerStyle}>{children}</View>
    </ScrollView>
  )
}

// RN Web passes it through to CSS; ViewStyle doesn't name it.
const anchorless: ViewStyle & { overflowAnchor: 'none' } = { overflowAnchor: 'none' }

const pageScroll = StyleSheet.create({
  fill: { flexGrow: 1 },
  anchorless
})

/** Never the node the browser's anchoring holds. */
export const outOfAnchoring = pageScroll.anchorless
