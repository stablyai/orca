import { useEffect, useState } from 'react'
import { AccessibilityInfo, Platform, Text } from 'react-native'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { cloudWorkspaceScreenStyles as styles } from './cloud-workspace-screen-styles'

// A wake alone usually takes about 5 s, and a whole open (wake, access, connect) about 10-12 s:
// reassure only when the wake itself, or the run as a whole, runs clearly past that.
export const CLOUD_WAKE_SLOW_MS = 10_000
export const CLOUD_RUN_SLOW_MS = 20_000

/** Which reassurance, if any: `waking` is the wake step itself (the prompt has not gone out yet). */
export function cloudWakeSlowMessage(
  elapsedMs: number,
  args: { waking: boolean; promptQueued: boolean },
  t: Translate
): string | null {
  if (args.waking && elapsedMs >= CLOUD_WAKE_SLOW_MS) {
    return args.promptQueued
      ? t(
          'cloud.wake.slowQueued',
          'Taking longer than usual. Your files are safe. Your prompt sends as soon as it’s awake.'
        )
      : t('cloud.wake.slow', 'Taking longer than usual. Your files are safe.')
  }
  // Awake but still connecting or sending: the prompt sentence would no longer be true.
  return elapsedMs >= CLOUD_RUN_SLOW_MS
    ? t('cloud.wake.slow', 'Taking longer than usual. Your files are safe.')
    : null
}

/**
 * Reassurance under the steps once a run goes long; the steps and their timer stay as they are.
 * Mount with `key={since}` so each run starts clean.
 */
export function CloudWakeSlowNote(props: {
  since: number
  waking: boolean
  promptQueued: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [now, setNow] = useState(() => Date.now())
  const threshold = props.waking ? CLOUD_WAKE_SLOW_MS : CLOUD_RUN_SLOW_MS
  useEffect(() => {
    const remaining = threshold - (Date.now() - props.since)
    if (remaining <= 0) {
      setNow(Date.now())
      return
    }
    // One timer for the next threshold, not a tick: the elapsed time beside the step already ticks.
    const timer = setTimeout(() => setNow(Date.now()), remaining)
    return () => clearTimeout(timer)
  }, [props.since, threshold])
  const message = cloudWakeSlowMessage(now - props.since, props, t)
  useEffect(() => {
    // Android announces the live region itself; iOS has none, so VoiceOver hears it once here.
    if (message && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(message)
    }
  }, [message])
  if (!message) {
    return null
  }
  return (
    <Text style={styles.statusLine} accessibilityLiveRegion="polite">
      {message}
    </Text>
  )
}
