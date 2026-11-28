import { useCallback, useRef, useState } from 'react'
import { View, BackHandler, ScrollView, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft, CircleAlert, Laptop } from 'lucide-react-native'
import {
  resolvePairConfirmRouteState,
  type PairConfirmRouteState
} from '../src/pairing/pair-confirm-state'
import {
  startPreProfilePairing,
  type PreProfilePairingAttempt
} from '../src/pairing/pre-profile-pairing-coordinator'
import type { ConnectionLogEntry } from '../src/diagnostics/connection/connection-log-types'
import { useRefreshHostClient } from '../src/transport/connection/host-client-hooks'
import { spacing, typography } from '../src/theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../src/theme/themed-styles'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import { formatConnectionLogHistory } from '../src/diagnostics/connection-diagnostics-report'
import { MobileStateView } from '../src/components/feedback/MobileStateView'
import { NavBar } from '../src/components/nav-bar/NavBar'
import { NavBarButton } from '../src/components/nav-bar/NavBarButton'
import { SheetPrimaryButton } from '../src/components/sheets/SheetPrimaryButton'
import { SheetSecondaryButton } from '../src/components/sheets/SheetSecondaryButton'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination
} from '../src/onboarding/mobile-onboarding-plan'
import {
  PAIRING_SUCCESS_HOLD_MS,
  PairingProgress,
  waitForBeat
} from '../src/pairing/pairing-visuals'
import { triggerSuccess } from '../src/platform/haptics/haptics'
import { getPairingFailureMessage } from '../src/pairing/pairing-failure-message'

type Status = 'awaiting-confirm' | 'connecting' | 'error'

// Bound initial pairing at ~25s (one connect timeout plus retry) so broken routes show an actionable error/log; live RPC retries indefinitely.
const PAIRING_OVERALL_TIMEOUT_MS = 25_000

export default function PairConfirmScreen() {
  const t = useMobileTranslation()
  const params = useLocalSearchParams<{ code?: string | string[] }>()
  return (
    <PairConfirmContent
      key={typeof params.code === 'string' ? params.code : undefined}
      routeState={resolvePairConfirmRouteState(params.code, t)}
    />
  )
}

function PairConfirmContent({ routeState }: { routeState: PairConfirmRouteState }) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const router = useRouter()
  const refreshHostClient = useRefreshHostClient()
  const insets = useSafeAreaInsets()
  const [status, setStatus] = useState<Status>('awaiting-confirm')
  const [paired, setPaired] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([])
  // Ref keeps RPC callback logs current and batches bursty state updates.
  const logsRef = useRef<ConnectionLogEntry[]>([])
  const mountedRef = useRef(true)
  const activePairingAttemptRef = useRef<PreProfilePairingAttempt | null>(null)

  const offer = routeState.offer
  const resolvedStatus =
    status === 'awaiting-confirm' && routeState.kind === 'error' ? 'error' : status
  const resolvedErrorMessage =
    status === 'awaiting-confirm' && routeState.kind === 'error'
      ? routeState.errorMessage
      : errorMessage

  const cancel = useCallback(() => {
    mountedRef.current = false
    activePairingAttemptRef.current?.dispose()
    activePairingAttemptRef.current = null
    router.replace('/')
  }, [router])

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        cancel()
        return true
      })
      return () => subscription.remove()
    }, [cancel])
  )

  const setPairConfirmRootRef = useCallback((node: HostInstance | null): void => {
    if (node !== null) {
      mountedRef.current = true
      return
    }
    // Dispose pairing on route detach: attempts can outlive the visible screen, before passive cleanup.
    mountedRef.current = false
    activePairingAttemptRef.current?.dispose()
    activePairingAttemptRef.current = null
  }, [])

  async function confirm() {
    if (!offer) {
      return
    }
    setStatus('connecting')
    logsRef.current = []
    setLogs([])
    activePairingAttemptRef.current?.dispose()

    const attempt = startPreProfilePairing({
      offer,
      timeoutMs: PAIRING_OVERALL_TIMEOUT_MS,
      connectOptions: {
        onLog: (entry) => {
          if (!mountedRef.current || activePairingAttemptRef.current !== attempt) {
            return
          }
          logsRef.current = [...logsRef.current, entry]
          setLogs(logsRef.current)
        }
      }
    })
    activePairingAttemptRef.current = attempt
    try {
      const { hostId } = await attempt.result
      const attemptIsCurrent = activePairingAttemptRef.current === attempt
      attempt.dispose()
      if (activePairingAttemptRef.current === attempt) {
        activePairingAttemptRef.current = null
      }
      if (!mountedRef.current || !attemptIsCurrent) {
        return
      }
      // Re-pair reuses host id; close cached client so it reloads the persisted endpoint/relay (STA-1840).
      refreshHostClient(hostId)
      setPaired(true)
      triggerSuccess()
      const [onboardingSteps] = await Promise.all([
        loadMobileOnboardingSteps(),
        waitForBeat(PAIRING_SUCCESS_HOLD_MS)
      ])
      if (!mountedRef.current) {
        return
      }
      router.replace(mobileOnboardingDestination(onboardingSteps, hostId))
    } catch (err) {
      const timedOut = attempt.timedOut
      const attemptIsCurrent = activePairingAttemptRef.current === attempt
      attempt.dispose()
      if (activePairingAttemptRef.current === attempt) {
        activePairingAttemptRef.current = null
      }
      if (!mountedRef.current || !attemptIsCurrent) {
        return
      }
      console.warn('[pair-confirm] connect failed', err)
      setStatus('error')
      setErrorMessage(
        getPairingFailureMessage({
          screen: 'confirm',
          error: err,
          timedOut,
          timeoutMs: PAIRING_OVERALL_TIMEOUT_MS,
          t
        })
      )
    }
  }

  let body
  if (offer && resolvedStatus === 'awaiting-confirm') {
    body = (
      <>
        <MobileStateView
          icon={Laptop}
          title={t('app.pairConfirm.pairThisComputer', 'Pair with this computer?')}
          message={t('app.pairConfirm.onlyYourOwn', 'Only pair with a computer you trust.')}
        />
        <View style={[styles.foot, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <SheetPrimaryButton
            label={t('app.pairConfirm.pairButton', 'Pair')}
            onPress={() => void confirm()}
          />
          <SheetSecondaryButton label={t('common.cancel', 'Cancel')} onPress={cancel} />
        </View>
      </>
    )
  } else if (resolvedStatus === 'connecting') {
    body = (
      <View style={[styles.centered, { paddingBottom: insets.bottom }]}>
        <PairingProgress
          succeeded={paired}
          connectingLabel={t('app.pairConfirm.connecting', 'Connecting…')}
          labelStyle={styles.connectingText}
        />
      </View>
    )
  } else {
    // Scrolls so an opened log never pushes Back to home off screen.
    body = (
      <ScrollView contentContainerStyle={styles.scrollFill}>
        <MobileStateView
          icon={CircleAlert}
          title={t('app.pairScan.couldNotPair', 'Couldn’t pair')}
          message={resolvedErrorMessage}
          details={logs.length > 0 ? formatConnectionLogHistory(logs) : null}
          action={{ label: t('app.pairConfirm.backToHome', 'Back to home'), onPress: cancel }}
          bottomInset={insets.bottom}
        />
      </ScrollView>
    )
  }

  return (
    <View ref={setPairConfirmRootRef} style={[styles.container, { paddingTop: insets.top }]}>
      <NavBar
        leading={
          <NavBarButton
            icon={ChevronLeft}
            accessibilityLabel={t('common.back', 'Back')}
            onPress={cancel}
          />
        }
      />
      {body}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  scrollFill: { flexGrow: 1 },
  foot: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  connectingText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    marginTop: spacing.lg
  }
}))
