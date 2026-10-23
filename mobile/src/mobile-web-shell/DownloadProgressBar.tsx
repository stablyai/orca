import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors } from '../theme/mobile-theme'
import { downloadFraction, type DownloadProgressFeed } from './download-progress-feed'

/** Long enough to read as motion between steps, short enough not to trail the caption. */
const FILL_EASE_MS = 100
/**
 * The feed fires per asset, often well under a frame apart, and a timing replaced that fast never
 * draws: the fill sat empty until the last one. One start per window gives each ease three frames,
 * three quarters of its step, before the next takes over from where it got to.
 */
const FILL_RESTART_MS = 50
// Why: web has no native driver.
const useNativeDriver = Platform.OS !== 'web'

export function downloadedMegabytesCaption(receivedBytes: number, totalBytes: number): string {
  return `${megabytes(receivedBytes)} of ${megabytes(totalBytes)} MB`
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

/**
 * The page bundle's download as a bar. The fill follows the feed on the native driver, so it keeps
 * moving while the JS thread is busy decoding; the byte counts are React's, for the caption and the
 * accessibility value that read them.
 */
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
  // Unread counts as motion allowed: the preference arrives with a React commit, which the download
  // can hold off. Read through a ref, so its arrival never re-subscribes mid-download.
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
      // Always the native driver, a jump included: a JS-side setValue only reaches the screen
      // through a React commit, and the download keeps those from happening.
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
      // Why: lands the last value of a burst if no later callback comes past the window to carry it.
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
