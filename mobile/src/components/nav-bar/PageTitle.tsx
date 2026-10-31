import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Animated,
  Platform,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

// Title plus one subtitle line before the first layout reports the real height.
const FALLBACK_TITLE_HEIGHT = 62
// A scroll that rests this long with the title half under the bar finishes the fold.
const SETTLE_DELAY_MS = 140

type PageTitleProps = {
  title: string
  /** One line under the title, e.g. a status dot and "Connected". */
  subtitle?: ReactNode
  onLayout?: (event: LayoutChangeEvent) => void
}

// A list's title at the top of its content; it scrolls away and the bar's own title fades in.
export function PageTitle({ title, subtitle, onLayout }: PageTitleProps) {
  useMobileColorScheme()
  return (
    <View style={styles.block} onLayout={onLayout}>
      <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      {subtitle !== undefined ? <View style={styles.subtitleRow}>{subtitle}</View> : null}
    </View>
  )
}

export type CollapsingTitle = ReturnType<typeof useCollapsingTitle>

/**
 * Scroll state shared by a NavBar and the list that holds its PageTitle: the bar title fades in as the
 * page title slides under it, following the finger, and a scroll left half-folded settles like iOS.
 */
export function useCollapsingTitle(scrollTo: (offset: number) => void) {
  const scrollY = useRef(new Animated.Value(0)).current
  const offsetRef = useRef(0)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touching = useRef(false)
  const [titleHeight, setTitleHeight] = useState(FALLBACK_TITLE_HEIGHT)

  useEffect(
    () => () => {
      if (settleTimer.current) {
        clearTimeout(settleTimer.current)
      }
    },
    []
  )

  // Settles only once the finger is up and the scroll has stopped, so it never fights a held drag.
  const scheduleSettle = useCallback(() => {
    if (settleTimer.current) {
      clearTimeout(settleTimer.current)
    }
    settleTimer.current = setTimeout(() => {
      const offset = offsetRef.current
      if (!touching.current && offset > 0 && offset < titleHeight) {
        scrollTo(offset < titleHeight / 2 ? 0 : titleHeight)
      }
    }, SETTLE_DELAY_MS)
  }, [scrollTo, titleHeight])

  const onScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: Platform.OS !== 'web',
        listener: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          offsetRef.current = event.nativeEvent.contentOffset.y
          scheduleSettle()
        }
      }),
    [scheduleSettle, scrollY]
  )

  // Touch events reach the list on native and in the page's WebView alike; drag callbacks don't on web.
  const touchHandlers = useMemo(
    () => ({
      onTouchStart: () => {
        touching.current = true
      },
      onTouchEnd: () => {
        touching.current = false
        scheduleSettle()
      },
      onTouchCancel: () => {
        touching.current = false
        scheduleSettle()
      }
    }),
    [scheduleSettle]
  )

  const onTitleLayout = useCallback((event: LayoutChangeEvent) => {
    const height = Math.round(event.nativeEvent.layout.height)
    if (height > 0) {
      setTitleHeight(height)
    }
  }, [])

  // The list went away (no rows), so nothing is scrolled under the bar any more.
  const reset = useCallback(() => {
    offsetRef.current = 0
    scrollY.setValue(0)
  }, [scrollY])

  const barTitleOpacity = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [titleHeight * 0.35, titleHeight * 0.7],
        outputRange: [0, 1],
        extrapolate: 'clamp'
      }),
    [scrollY, titleHeight]
  )
  const barDividerOpacity = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [titleHeight * 0.7, titleHeight],
        outputRange: [0, 1],
        extrapolate: 'clamp'
      }),
    [scrollY, titleHeight]
  )

  return { onScroll, touchHandlers, onTitleLayout, reset, barTitleOpacity, barDividerOpacity }
}

const styles = themedStyleSheet(() => ({
  block: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
    gap: 3
  },
  // Home's "Welcome back" size: room for the name, well short of iOS's 34 pt large title.
  title: {
    color: colors.textPrimary,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '700',
    letterSpacing: -0.3
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minWidth: 0
  }
}))
