import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, Text, View } from 'react-native'
import { OrcaLogo } from '../components/OrcaLogo'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { useReducedMotionEnabled } from './use-reduced-motion'

const SAMPLE_NOTIFICATIONS = [
  { title: 'Codex finished', body: 'Tests are passing.' },
  { title: 'Claude needs input', body: 'Waiting on you.' }
] as const

const ENTER_MS = 676
const EXIT_MS = 416
const STAGGER_MS = 546
const HOLD_MS = 2860
const GAP_MS = 624
const SLIDE_FROM_Y = -22

type Props = {
  active: boolean
}

/** Decorative banners; the surrounding copy is the accessible explanation. */
export function NotificationOnboardingPreview({ active }: Props) {
  const reduceMotion = useReducedMotionEnabled()
  const first = useRef(new Animated.Value(0)).current
  const second = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!active || reduceMotion === null) {
      first.setValue(0)
      second.setValue(0)
      return
    }
    if (reduceMotion) {
      first.setValue(1)
      second.setValue(1)
      return
    }

    const enter = (value: Animated.Value) =>
      Animated.timing(value, {
        toValue: 1,
        duration: ENTER_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      })
    const leave = (value: Animated.Value) =>
      Animated.timing(value, {
        toValue: 0,
        duration: EXIT_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true
      })
    const loop = Animated.loop(
      Animated.sequence([
        enter(first),
        Animated.delay(STAGGER_MS),
        enter(second),
        Animated.delay(HOLD_MS),
        Animated.parallel([leave(first), leave(second)]),
        Animated.delay(GAP_MS)
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [active, first, reduceMotion, second])

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      testID="notification-onboarding-preview"
      style={styles.stack}
    >
      <Animated.View style={bannerMotion(first)}>
        <SampleBanner notification={SAMPLE_NOTIFICATIONS[0]} />
      </Animated.View>
      <Animated.View style={bannerMotion(second)}>
        <SampleBanner notification={SAMPLE_NOTIFICATIONS[1]} />
      </Animated.View>
    </View>
  )
}

function SampleBanner({ notification }: { notification: (typeof SAMPLE_NOTIFICATIONS)[number] }) {
  return (
    <View style={styles.card}>
      <View style={styles.appIcon}>
        <OrcaLogo size={14} />
      </View>
      <View style={styles.cardCopy}>
        <View style={styles.cardMeta}>
          <Text style={styles.appName}>Orca</Text>
          <Text style={styles.now}>now</Text>
        </View>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {notification.title}
        </Text>
        <Text style={styles.cardBody} numberOfLines={1}>
          {notification.body}
        </Text>
      </View>
    </View>
  )
}

function bannerMotion(progress: Animated.Value) {
  return {
    opacity: progress,
    transform: [
      {
        translateY: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [SLIDE_FROM_Y, 0]
        })
      }
    ]
  }
}

const styles = StyleSheet.create({
  stack: {
    width: '100%',
    maxWidth: 320,
    gap: spacing.sm,
    marginBottom: spacing.xl + spacing.lg
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.bgPanel,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md
  },
  appIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.camera,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  cardCopy: {
    flex: 1,
    minWidth: 0
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2
  },
  appName: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  now: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  cardBody: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginTop: 1
  }
})
