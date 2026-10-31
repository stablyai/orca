import { useCallback, useRef, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, BackHandler } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import {
  resolvePairConfirmRouteState,
  type PairConfirmRouteState
} from '../src/transport/pair-confirm-state'
import {
  startPreProfilePairing,
  type PreProfilePairingAttempt
} from '../src/transport/pre-profile-pairing-coordinator'
import type { ConnectionLogEntry } from '../src/transport/types'
import { useRefreshHostClient } from '../src/transport/host-client-hooks'
import { colors, spacing, radii, typography } from '../src/theme/mobile-theme'
import { themedStyleSheet } from '../src/theme/themed-styles'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import { ConnectionLog } from '../src/components/ConnectionLog'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination
} from '../src/onboarding/mobile-onboarding-plan'

type Status = 'awaiting-confirm' | 'connecting' | 'error'

// Bound initial pairing at ~25s (one connect timeout plus retry) so broken routes show an actionable error/log; live RPC retries indefinitely.
const PAIRING_OVERALL_TIMEOUT_MS = 25_000

export default function PairConfirmScreen() {
  useMobileTranslation()
  const params = useLocalSearchParams<{ code?: string | string[] }>()
  return (
    <PairConfirmContent
      key={typeof params.code === 'string' ? params.code : undefined}
      routeState={resolvePairConfirmRouteState(params.code)}
    />
  )
}

function PairConfirmContent({ routeState }: { routeState: PairConfirmRouteState }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const refreshHostClient = useRefreshHostClient()
  const insets = useSafeAreaInsets()
  const [status, setStatus] = useState<Status>('awaiting-confirm')
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

  const setPairConfirmRootRef = useCallback((node: View | null): void => {
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
      const onboardingSteps = await loadMobileOnboardingSteps()
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
        timedOut
          ? t(
              'app.pairConfirm.connectTimedOut',
              "Couldn't connect within {{seconds}}s — see log below for where it stalled",
              { seconds: PAIRING_OVERALL_TIMEOUT_MS / 1000 }
            )
          : t('app.pairConfirm.pairingFailed', 'Pairing failed: {{error}}', {
              error: err instanceof Error ? err.message : String(err)
            })
      )
    }
  }

  const containerPadding = { paddingTop: insets.top + spacing.sm }

  return (
    <View ref={setPairConfirmRootRef} style={[styles.container, containerPadding]}>
      <Pressable
        style={styles.backButton}
        onPress={cancel}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('common.back', 'Back')}
      >
        <ChevronLeft size={22} color={colors.textSecondary} />
      </Pressable>

      <View style={styles.content}>
        {offer && resolvedStatus === 'awaiting-confirm' && (
          <>
            <Text style={styles.title}>
              {t('app.pairConfirm.title', 'Pair with this desktop?')}
            </Text>
            <Text style={styles.subtitle}>
              {t(
                'app.pairConfirm.description',
                'You opened a pairing link from your desktop. Confirm to add it to your hosts.'
              )}
            </Text>
            <View style={styles.actionStack}>
              <Pressable style={styles.primaryButton} onPress={() => void confirm()}>
                <Text style={styles.primaryButtonText}>
                  {t('app.pairConfirm.pairButton', 'Pair')}
                </Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={cancel}>
                <Text style={styles.secondaryButtonText}>{t('common.cancel', 'Cancel')}</Text>
              </Pressable>
            </View>
          </>
        )}

        {resolvedStatus === 'connecting' && (
          <>
            <ActivityIndicator size="large" color={colors.textSecondary} />
            <Text style={styles.connectingText}>
              {t('app.pairConfirm.connecting', 'Connecting…')}
            </Text>
            <View style={styles.logSlot}>
              <ConnectionLog
                entries={logs}
                title={t('app.pairConfirm.pairingLog', 'Pairing log')}
              />
            </View>
          </>
        )}

        {resolvedStatus === 'error' && (
          <>
            <Text style={styles.errorText}>{resolvedErrorMessage}</Text>
            {logs.length > 0 && (
              <View style={styles.logSlot}>
                <ConnectionLog
                  entries={logs}
                  title={t('app.pairConfirm.pairingLog', 'Pairing log')}
                />
              </View>
            )}
            <View style={styles.actionStack}>
              <Pressable style={styles.primaryButton} onPress={cancel}>
                <Text style={styles.primaryButtonText}>
                  {t('app.pairConfirm.backToHome', 'Back to home')}
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    // Offset above geometric center to balance home-indicator/nav-bar space.
    paddingBottom: spacing.xl * 2
  },
  title: {
    fontSize: typography.titleSize,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.sm,
    textAlign: 'center'
  },
  subtitle: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    lineHeight: 20,
    marginBottom: spacing.xl,
    textAlign: 'center',
    maxWidth: 520,
    alignSelf: 'center'
  },
  actionStack: {
    width: '100%',
    maxWidth: 360,
    alignSelf: 'center'
  },
  primaryButton: {
    width: '100%',
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.control,
    alignItems: 'center',
    marginBottom: spacing.sm
  },
  primaryButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  secondaryButton: {
    width: '100%',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.control,
    alignItems: 'center'
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  connectingText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    marginTop: spacing.lg,
    textAlign: 'center'
  },
  logSlot: {
    width: '100%',
    marginTop: spacing.lg,
    marginBottom: spacing.md
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    textAlign: 'center',
    marginBottom: spacing.xl,
    lineHeight: 20
  }
}))
