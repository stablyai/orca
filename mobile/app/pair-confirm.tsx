import { useCallback, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  ScrollView
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import {
  resolvePairConfirmRouteState,
  type PairConfirmRouteState
} from '../src/transport/pair-confirm-state'
import {
  startPairingWithEdgeAuth,
  type PairingEdgeAuthAttempt
} from '../src/transport/pairing-edge-auth-attempt'
import type { ConnectionLogEntry } from '../src/transport/types'
import { useRefreshHostClient } from '../src/transport/host-client-hooks'
import { colors, spacing, pressedStyle } from '../src/theme/mobile-theme'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import {
  PAIRING_SUCCESS_HOLD_MS,
  PairingProgress,
  waitForBeat
} from '../src/pairing/pairing-visuals'
import { triggerSuccess } from '../src/platform/haptics'
import { ConnectionLog } from '../src/components/ConnectionLog'
import {
  EdgeAuthHeadersSection,
  useEdgeAuthHeaders,
  type EdgeAuthScrollTarget
} from '../src/components/edge-auth-headers-section'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination
} from '../src/onboarding/mobile-onboarding-plan'
import { pairConfirmStyles as styles } from '../src/pair-confirm-styles'

const PAIRING_OVERALL_TIMEOUT_MS = 25_000

type VerifiedHost = { hostId: string; credentialsSaved: boolean }
export default function PairConfirmScreen() {
  useMobileTranslation()
  const params = useLocalSearchParams<{ code?: string | string[] }>()
  return (
    <PairConfirmAttemptScreen
      key={typeof params.code === 'string' ? params.code : undefined}
      routeState={resolvePairConfirmRouteState(params.code)}
    />
  )
}

function PairConfirmAttemptScreen({ routeState }: { routeState: PairConfirmRouteState }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const refreshHostClient = useRefreshHostClient()
  const insets = useSafeAreaInsets()
  const [paired, setPaired] = useState(false)
  const offer = routeState.offer
  const edgeAuth = useEdgeAuthHeaders()
  const scrollTarget = useRef<EdgeAuthScrollTarget | null>(null)
  const secure = Platform.OS !== 'web' && offer?.endpoint.toLowerCase().startsWith('wss://')
  const [status, setStatus] = useState<'awaiting-confirm' | 'connecting' | 'error'>(
    'awaiting-confirm'
  )
  const [errorMessage, setErrorMessage] = useState('')
  const [verifiedHost, setVerifiedHost] = useState<VerifiedHost | null>(null)
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([])
  const mounted = useRef(true)
  const generation = useRef(0)
  const busy = useRef(false)
  const activeAttempt = useRef<PairingEdgeAuthAttempt | null>(null)
  const invalidate = useCallback(() => {
    generation.current += 1
    activeAttempt.current?.dispose()
    activeAttempt.current = null
  }, [])
  const cancel = useCallback(() => {
    mounted.current = false
    invalidate()
    router.replace('/')
  }, [invalidate, router])
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        cancel()
        return true
      })
      return () => {
        subscription.remove()
        invalidate()
      }
    }, [cancel, invalidate])
  )
  const rootRef = useCallback(
    (node: View | null) => {
      mounted.current = node !== null
      if (!node) {
        invalidate()
      }
    },
    [invalidate]
  )

  async function confirm() {
    if (!offer || busy.current || (secure && !verifiedHost && !edgeAuth.authNormalized.ok)) {
      return
    }
    busy.current = true
    setStatus('connecting')
    setErrorMessage('')
    const submission = verifiedHost ? generation.current : ++generation.current
    const isCurrent = () => mounted.current && generation.current === submission
    try {
      let verified = verifiedHost
      if (!verified) {
        setLogs([])
        activeAttempt.current?.dispose()
        const attempt = startPairingWithEdgeAuth({
          offer,
          timeoutMs: PAIRING_OVERALL_TIMEOUT_MS,
          headers: secure && edgeAuth.authNormalized.ok ? edgeAuth.authNormalized.headers : null,
          isCurrent,
          connectOptions: {
            onLog: (entry) => {
              if (isCurrent()) {
                setLogs((previous) => [...previous, entry])
              }
            }
          }
        })
        activeAttempt.current = attempt
        verified = await attempt.result
        if (!isCurrent()) {
          return
        }
        setVerifiedHost(verified)
      } else if (!verified.credentialsSaved) {
        const attempt = activeAttempt.current
        if (!attempt) {
          throw new Error('Pairing no longer active')
        }
        await attempt.retryCredentialSave()
        verified = { ...verified, credentialsSaved: true }
        if (!isCurrent()) {
          return
        }
        setVerifiedHost(verified)
      }
      if (!verified.credentialsSaved) {
        setStatus('error')
        setErrorMessage(
          t(
            'app.pairConfirm.edgeCredentialsFailed',
            'The host was paired, but its edge credentials could not be saved. Retry saving, or enter them later in Edit Host.'
          )
        )
        return
      }
      refreshHostClient(verified.hostId)
      setPaired(true)
      triggerSuccess()
      const [steps] = await Promise.all([
        loadMobileOnboardingSteps(),
        waitForBeat(PAIRING_SUCCESS_HOLD_MS)
      ])
      if (!isCurrent()) {
        return
      }
      activeAttempt.current?.dispose()
      activeAttempt.current = null
      router.replace(mobileOnboardingDestination(steps, verified.hostId))
    } catch {
      if (isCurrent()) {
        setStatus('error')
        setErrorMessage(
          activeAttempt.current?.timedOut
            ? t(
                'app.pairConfirm.connectTimedOut',
                "Couldn't connect within {{seconds}}s — see log below for where it stalled",
                { seconds: PAIRING_OVERALL_TIMEOUT_MS / 1000 }
              )
            : t(
                'app.pairConfirm.edgePairingFailed',
                'Could not finish pairing or save credentials. Check the connection and protected storage, then retry.'
              )
        )
      }
    } finally {
      busy.current = false
    }
  }
  const error = routeState.kind === 'error' ? routeState.errorMessage : errorMessage
  const showForm = offer && status !== 'connecting' && !verifiedHost
  return (
    <View ref={rootRef} style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable
        style={({ pressed }) => [styles.backButton, pressed && pressedStyle]}
        onPress={cancel}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('common.back', 'Back')}
      >
        <ChevronLeft size={22} color={colors.textSecondary} />
      </Pressable>
      <KeyboardAvoidingView
        style={styles.content}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={(node) => {
            scrollTarget.current = node
          }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
        >
          {error ? (
            <Text style={styles.errorText} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          {showForm ? (
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
              {secure ? (
                <EdgeAuthHeadersSection
                  rows={edgeAuth.authRows}
                  storedCount={0}
                  error={edgeAuth.authNormalized.ok ? null : edgeAuth.authNormalized.error}
                  onRowsChange={edgeAuth.setAuthRows}
                  scrollViewRef={scrollTarget}
                  hint={t(
                    'edgeAuth.pairingHint',
                    "Optional headers for this secure tunnel. Orca verifies the desktop before saving them in this phone's keychain. Never include them in a pairing link."
                  )}
                />
              ) : null}
              <View style={styles.actionStack}>
                <Pressable
                  style={({ pressed }) => [styles.primaryButton, pressed && pressedStyle]}
                  accessibilityRole="button"
                  accessibilityLabel={t('app.pairConfirm.pairButton', 'Pair')}
                  disabled={Boolean(secure && !edgeAuth.authNormalized.ok)}
                  onPress={confirm}
                >
                  <Text style={styles.primaryButtonText}>
                    {t('app.pairConfirm.pairButton', 'Pair')}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.secondaryButton, pressed && pressedStyle]}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.cancel', 'Cancel')}
                  onPress={cancel}
                >
                  <Text style={styles.secondaryButtonText}>{t('common.cancel', 'Cancel')}</Text>
                </Pressable>
              </View>
            </>
          ) : null}
          {status === 'connecting' ? (
            <PairingProgress
              succeeded={paired}
              connectingLabel={
                verifiedHost
                  ? t('edgeAuth.saving', 'Saving credentials…')
                  : t('app.pairConfirm.connecting', 'Connecting…')
              }
              labelStyle={styles.connectingText}
            />
          ) : null}
          {logs.length > 0 ? (
            <View style={styles.logSlot}>
              <ConnectionLog
                entries={logs}
                title={t('app.pairConfirm.pairingLog', 'Pairing log')}
              />
            </View>
          ) : null}
          {(verifiedHost || !offer) && status !== 'connecting' ? (
            <View style={styles.actionStack}>
              {verifiedHost ? (
                <Pressable
                  style={({ pressed }) => [styles.primaryButton, pressed && pressedStyle]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    verifiedHost.credentialsSaved
                      ? t('common.continue', 'Continue')
                      : t('app.pairConfirm.retryCredentials', 'Retry saving credentials')
                  }
                  onPress={confirm}
                >
                  <Text style={styles.primaryButtonText}>
                    {verifiedHost.credentialsSaved
                      ? t('common.continue', 'Continue')
                      : t('app.pairConfirm.retryCredentials', 'Retry saving credentials')}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                style={({ pressed }) => [styles.secondaryButton, pressed && pressedStyle]}
                accessibilityRole="button"
                accessibilityLabel={t('app.pairConfirm.backToHome', 'Back to home')}
                onPress={cancel}
              >
                <Text style={styles.secondaryButtonText}>
                  {t('app.pairConfirm.backToHome', 'Back to home')}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}
