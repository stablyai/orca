import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Animated, Platform, Text, View } from 'react-native'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { Banner } from '../components/ui/Banner'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'
import type { OlderPagePhase } from './use-mobile-older-page-loader'

const LOAD_EARLIER_FAILED = "Couldn't load earlier messages."
const LOAD_EARLIER_RETRY = 'Try again'
const EARLIER_UNAVAILABLE = "Earlier messages can't be loaded."
const LOADING_EARLIER = 'Loading earlier messages…'
/** A page that lands this fast never shows its spinner. */
const SPINNER_DELAY_MS = 200
const FADE_MS = 180

function FadeIn({ delay, children }: { delay: number; children: ReactNode }): ReactElement {
  const [opacity] = useState(() => new Animated.Value(0))
  useEffect(() => {
    const fade = Animated.timing(opacity, {
      toValue: 1,
      duration: FADE_MS,
      delay,
      useNativeDriver: Platform.OS !== 'web'
    })
    fade.start()
    return () => fade.stop()
  }, [opacity, delay])
  return <Animated.View style={{ opacity }}>{children}</Animated.View>
}

/** The top of a chat with older history. It loads on its own as the reader nears it, so this is a
 *  quiet spinner, a retry only after a failure, and nothing once history ends. */
export function mobileNativeChatListHeader(
  hasMore: boolean | undefined,
  olderPages: OlderPagePhase | undefined,
  loadEarlier: () => void
): ReactElement | null {
  if (olderPages === 'unavailable') {
    return (
      <View style={styles.loadEarlier}>
        <FadeIn delay={0}>
          <Text style={styles.loadEarlierFailedText}>{EARLIER_UNAVAILABLE}</Text>
        </FadeIn>
      </View>
    )
  }
  if (!hasMore) {
    return null
  }
  if (olderPages === 'failed') {
    return (
      <View style={styles.loadEarlierFailed}>
        <FadeIn delay={0}>
          <Banner
            message={LOAD_EARLIER_FAILED}
            action={{ label: LOAD_EARLIER_RETRY, onPress: loadEarlier }}
          />
        </FadeIn>
      </View>
    )
  }
  return (
    <View style={styles.loadEarlier} accessibilityLabel={LOADING_EARLIER}>
      <FadeIn key="loading" delay={SPINNER_DELAY_MS}>
        <LoadingSpinner size={16} color={colors.textMuted} label={LOADING_EARLIER} />
      </FadeIn>
    </View>
  )
}
