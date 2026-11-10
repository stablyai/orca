import { useEffect, useState } from 'react'
import { AccessibilityInfo, Platform, Text } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  CLOUD_RUN_SLOW_MS,
  CLOUD_WAKE_SLOW_MS,
  cloudWakeSlowMessage
} from './cloud-wake-slow-message'
import { cloudWorkspaceScreenStyles as styles } from './cloud-workspace-screen-styles'

/**
 * Reassurance under the steps once a run goes long; the steps and their timer stay as they are.
 * Once shown it stays for the rest of the run (its text may shorten when the wake step ends) and
 * is announced only on its first appearance. Mount with `key={since}` so each run starts clean.
 */
export function CloudWakeSlowNote(props: {
  since: number
  waking: boolean
  promptQueued: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [now, setNow] = useState(() => Date.now())
  const [shownBefore, setShownBefore] = useState(false)
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
  const message = cloudWakeSlowMessage(now - props.since, { ...props, shownBefore }, t)
  const visible = message !== null
  useEffect(() => {
    if (!visible || shownBefore) {
      return
    }
    setShownBefore(true)
    // Android announces the live region itself; iOS has none, so VoiceOver hears it once here.
    if (message && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(message)
    }
  }, [visible, shownBefore, message])
  if (!message) {
    return null
  }
  // The same element throughout. Android's live region speaks only the first appearance: after it,
  // the region turns off so the shorter text after the wake is not read out again.
  return (
    <Text style={styles.statusLine} accessibilityLiveRegion={shownBefore ? 'none' : 'polite'}>
      {message}
    </Text>
  )
}
