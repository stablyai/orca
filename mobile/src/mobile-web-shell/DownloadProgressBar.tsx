import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors } from '../theme/mobile-theme'
import { downloadFraction, type DownloadProgressFeed } from './download-progress-feed'

const FILL_EASE_MS = 100
// Asset events can arrive within a frame; throttle timing starts so each ease paints before the next replaces it.
const FILL_RESTART_MS = 50
const useNativeDriver = Platform.OS !== 'web'

export function downloadedMegabytesCaption(receivedBytes: number, totalBytes: number): string {
  return `${megabytes(receivedBytes)} of ${megabytes(totalBytes)} MB`
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

// Use the native driver so the bar moves while JS decodes; React still supplies caption and accessibility byte counts.
export function DownloadProgressBar({
  feed,
  receivedBytes,
  totalBytes,
  accessibilityLabel,
  testID
}: {
  feed: DownloadProgressFeed
  receivedBytes: number
  totalBytes: number
  accessibilityLabel: string
  testID?: string
}) {
  const [fill] = useState(() => new Animated.Value(feed.current()))
  // Default unread motion preference to allowed; read via ref so its delayed commit cannot resubscribe mid-download.
  const reducedMotion = useReducedMotionEnabled() === true
  const reducedMotionRef = useRef(reducedMotion)
  useEffect(() => {
    reducedMotionRef.current = reducedMotion
  }, [reducedMotion])
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- Cleanup clears the trailing timer the listener arms.
  useEffect(() => {
    let easing: Animated.CompositeAnimation | null = null
    let easedAt = Number.NEGATIVE_INFINITY
    let latest = 0
    let trailing: ReturnType<typeof setTimeout> | undefined
    const follow = (fraction: number, duration: number): void => {
      // Even jumps use the native driver; JS setValue waits for React commits that downloading can delay.
      easing = Animated.timing(fill, {
        toValue: fraction,
        duration,
        easing: Easing.out(Easing.quad),
        isInteraction: false,
        useNativeDriver
      })
      easing.start()
    }
    const ease = (fraction: number): void => {
      clearTimeout(trailing)
      trailing = undefined
      easedAt = Date.now()
      follow(fraction, reducedMotionRef.current ? 0 : FILL_EASE_MS)
    }
    follow(feed.current(), 0)
    const unsubscribe = feed.subscribe((fraction) => {
      const wait = easedAt + FILL_RESTART_MS - Date.now()
      if (fraction >= 1 || wait <= 0) {
        ease(fraction)
        return
      }
      latest = fraction
      // Flush the burst’s last value even if no later event arrives after the throttle window.
      trailing ??= setTimeout(() => ease(latest), wait)
    })
    return () => {
      unsubscribe()
      clearTimeout(trailing)
      easing?.stop()
    }
  }, [feed, fill])
  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: Math.round(downloadFraction(receivedBytes, totalBytes) * 100)
      }}
      testID={testID}
    >
      <Animated.View style={[styles.fill, { transform: [{ scaleX: fill }] }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  track: {
    width: 180,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised
  },
  fill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.textSecondary,
    transformOrigin: 'left'
  }
})
