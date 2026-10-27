import { useCallback, useMemo, useRef, useState } from 'react'
import { Animated, BackHandler, Text, View, type LayoutChangeEvent } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { OrcaLogo } from '../src/components/OrcaLogo'
import { ensureNotificationPermissions } from '../src/notifications/mobile-notifications'
import {
  MobileOnboardingPage,
  type MobileOnboardingBusyChoice,
  type NotificationOnboardingChoice
} from '../src/onboarding/MobileOnboardingPage'
import { parseMobileOnboardingSteps } from '../src/onboarding/mobile-onboarding-plan'
import { useReducedMotionEnabled } from '../src/platform/use-reduced-motion'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import { mobileOnboardingStyles as styles } from '../src/onboarding/mobile-onboarding-styles'
import {
  saveDefaultSessionView,
  type MobileSessionView
} from '../src/storage/session-view-preferences'
import { setRemotePushEnabled } from '../src/notifications/push-registration'

const SLIDE_DURATION_MS = 280

export default function MobileOnboardingScreen() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    steps?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const rawSteps = firstParam(params.steps)

  return (
    <MobileOnboardingFlow
      key={`${hostId ?? 'home'}:${rawSteps ?? 'all'}`}
      hostId={hostId}
      rawSteps={rawSteps}
    />
  )
}

function MobileOnboardingFlow({
  hostId,
  rawSteps
}: {
  hostId: string | undefined
  rawSteps: string | undefined
}) {
  useMobileColorScheme()
  const router = useRouter()
  const steps = useMemo(() => parseMobileOnboardingSteps(rawSteps), [rawSteps])
  // Measure pager viewport: iPad sheet is narrower than window; null waits for first layout.
  const [width, setWidth] = useState<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [busyChoice, setBusyChoice] = useState<MobileOnboardingBusyChoice>(null)
  const [error, setError] = useState<string | null>(null)
  const choiceInFlightRef = useRef(false)
  const slideProgress = useRef(new Animated.Value(0)).current
  const reducedMotionEnabled = useReducedMotionEnabled()

  // Block Android hardware Back too; stack gesture settings alone cannot require every onboarding choice.
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => true)
      return () => subscription.remove()
    }, [])
  )

  const continueToApp = useCallback(() => {
    router.replace(hostId ? `/h/${hostId}` : '/')
  }, [hostId, router])

  const advanceOrContinue = useCallback(() => {
    const nextIndex = activeIndex + 1
    if (nextIndex >= steps.length) {
      continueToApp()
      return
    }
    setActiveIndex(nextIndex)
    setError(null)
    Animated.timing(slideProgress, {
      toValue: nextIndex,
      // Preserve carousel continuity while honoring reduced motion.
      duration: reducedMotionEnabled === true ? 0 : SLIDE_DURATION_MS,
      useNativeDriver: true
    }).start(() => {
      // Cancelled cosmetic animation must not block the next choice after previous choice persisted.
      setBusyChoice(null)
      choiceInFlightRef.current = false
    })
  }, [activeIndex, continueToApp, reducedMotionEnabled, slideProgress, steps.length])

  const chooseSessionView = useCallback(
    async (view: MobileSessionView) => {
      // Ref prevents rapid taps persisting conflicting choices before state disables buttons.
      if (choiceInFlightRef.current) {
        return
      }
      choiceInFlightRef.current = true
      setBusyChoice(view)
      setError(null)
      try {
        await saveDefaultSessionView(view)
        advanceOrContinue()
      } catch {
        setError('Your choice could not be saved. Try again.')
        setBusyChoice(null)
        choiceInFlightRef.current = false
      }
    },
    [advanceOrContinue]
  )

  const chooseNotifications = useCallback(
    async (choice: NotificationOnboardingChoice) => {
      if (choiceInFlightRef.current) {
        return
      }
      choiceInFlightRef.current = true
      setBusyChoice(choice)
      setError(null)
      try {
        const enabled = choice === 'enable' ? await ensureNotificationPermissions() : false
        await setRemotePushEnabled(enabled)
        advanceOrContinue()
      } catch {
        setError('Notification settings could not be updated. Try again.')
        setBusyChoice(null)
        choiceInFlightRef.current = false
      }
    },
    [advanceOrContinue]
  )

  const translateX = useMemo(
    () => Animated.multiply(slideProgress, -(width ?? 0)),
    [slideProgress, width]
  )
  const onViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width
    // Ignore transient zero width to keep slides visible.
    if (measured > 0) {
      setWidth(measured)
    }
  }, [])

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.brandRow}>
        <OrcaLogo size={22} />
        <Text style={styles.brandName}>Orca</Text>
        {steps.length > 1 ? (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Onboarding progress"
            accessibilityValue={{ text: `Step ${activeIndex + 1} of ${steps.length}` }}
            style={styles.progress}
          >
            {steps.map((step, index) => (
              <View
                key={step}
                style={[styles.progressDot, index === activeIndex && styles.progressDotActive]}
              />
            ))}
          </View>
        ) : null}
      </View>

      <View style={styles.carouselViewport} onLayout={onViewportLayout}>
        {width === null ? null : (
          <Animated.View
            style={[
              styles.carouselTrack,
              { width: width * steps.length, transform: [{ translateX }] }
            ]}
          >
            {steps.map((step, index) => (
              <MobileOnboardingPage
                key={step}
                step={step}
                width={width}
                active={index === activeIndex}
                busyChoice={busyChoice}
                error={error}
                onSessionChoice={(view) => void chooseSessionView(view)}
                onNotificationChoice={(choice) => void chooseNotifications(choice)}
              />
            ))}
          </Animated.View>
        )}
      </View>
    </SafeAreaView>
  )
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
