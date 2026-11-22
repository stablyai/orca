import { useEffect, useRef, type ReactNode } from 'react'
import {
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type ScrollViewInstance,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { useWindowSafeAreaInsets } from '../../layout/side-safe-area'
import { spacing } from '../../theme/mobile-theme'
import type { MountedBottomDrawerProps } from './mounted-bottom-drawer'

// Room the system keeps above a full-height sheet and for its grabber.
const SHEET_CHROME_GAP = 56

type Props = Pick<
  MountedBottomDrawerProps,
  'contentScrollable' | 'fillAvailable' | 'scrollResetKey'
> & {
  style: StyleProp<ViewStyle>
  children: ReactNode
}

/** A drawer's React Native content as a system sheet holds it: scrolled, static or filling. */
export function NativeBottomDrawerBody({
  contentScrollable = true,
  fillAvailable = false,
  scrollResetKey = null,
  style,
  children
}: Props) {
  const scrollRef = useRef<ScrollViewInstance>(null)
  useEffect(() => {
    if (scrollResetKey !== null) {
      scrollRef.current?.scrollTo({ y: 0, animated: false })
    }
  }, [scrollResetKey])
  const { height } = useWindowDimensions()
  const insets = useWindowSafeAreaInsets()
  // A content-sized sheet takes its height from this view, so it must stop short of the screen for its list to scroll.
  const maxHeight = Math.max(0, height - insets.top - insets.bottom - SHEET_CHROME_GAP)
  const content = contentScrollable ? (
    <ScrollView
      ref={scrollRef}
      style={fillAvailable ? styles.fill : styles.shrink}
      bounces={false}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={fillAvailable ? styles.fill : styles.shrink}>{children}</View>
  )
  return (
    <View style={[styles.frame, style, fillAvailable ? styles.fill : { maxHeight }]}>
      {content}
    </View>
  )
}

const styles = StyleSheet.create({
  frame: { paddingHorizontal: spacing.md, paddingBottom: spacing.lg },
  fill: { flex: 1 },
  shrink: { flexGrow: 0, flexShrink: 1, minHeight: 0 }
})
