import { useCallback, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  ScrollView
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { resolvePairConfirmRouteState } from '../src/transport/pair-confirm-state'
import {
  startPairingWithEdgeAuth,
  type PairingEdgeAuthAttempt
} from '../src/transport/pairing-edge-auth-attempt'
import type { ConnectionLogEntry } from '../src/transport/types'
import { useRefreshHostClient } from '../src/transport/host-client-hooks'
import { colors, spacing } from '../src/theme/mobile-theme'
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
  const { code } = useLocalSearchParams<{ code?: string }>()
  return <PairConfirmAttemptScreen key={code ?? ''} code={code} />
}

function PairConfirmAttemptScreen({ code }: { code: string | undefined }) {
  const router = useRouter()
  const refreshHostClient = useRefreshHostClient()
  const insets = useSafeAreaInsets()
  const routeState = resolvePairConfirmRouteState(code)
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
          'The host was paired, but its edge credentials could not be saved. Retry saving, or enter them later in Edit Host.'
        )
        return
      }
      refreshHostClient(verified.hostId)
      const steps = await loadMobileOnboardingSteps()
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
            ? "Couldn't connect within 25s. Check the connection and try again."
            : 'Could not finish pairing or save credentials. Check the connection and protected storage, then retry.'
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
        style={styles.backButton}
        onPress={cancel}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Back"
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
              <Text style={styles.title}>Pair with this desktop?</Text>
              <Text style={styles.subtitle}>Confirm to add this desktop to your hosts.</Text>
              {secure ? (
                <EdgeAuthHeadersSection
                  rows={edgeAuth.authRows}
                  storedCount={0}
                  error={edgeAuth.authNormalized.ok ? null : edgeAuth.authNormalized.error}
                  onRowsChange={edgeAuth.setAuthRows}
                  scrollViewRef={scrollTarget}
                  hint="Optional headers for this secure tunnel. Orca verifies the desktop before saving them in this phone's keychain. Never include them in a pairing link."
                />
              ) : null}
              <View style={styles.actionStack}>
                <Pressable
                  style={styles.primaryButton}
                  accessibilityRole="button"
                  accessibilityLabel="Pair"
                  disabled={Boolean(secure && !edgeAuth.authNormalized.ok)}
                  onPress={confirm}
                >
                  <Text style={styles.primaryButtonText}>Pair</Text>
                </Pressable>
                <Pressable
                  style={styles.secondaryButton}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  onPress={cancel}
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </>
          ) : null}
          {status === 'connecting' ? (
            <>
              <ActivityIndicator size="large" color={colors.textSecondary} />
              <Text style={styles.connectingText}>
                {verifiedHost ? 'Saving credentials…' : 'Connecting…'}
              </Text>
            </>
          ) : null}
          {logs.length > 0 ? (
            <View style={styles.logSlot}>
              <ConnectionLog entries={logs} title="Pairing log" />
            </View>
          ) : null}
          {verifiedHost && status !== 'connecting' ? (
            <View style={styles.actionStack}>
              <Pressable
                style={styles.primaryButton}
                accessibilityRole="button"
                accessibilityLabel={
                  verifiedHost.credentialsSaved ? 'Continue' : 'Retry saving credentials'
                }
                onPress={confirm}
              >
                <Text style={styles.primaryButtonText}>
                  {verifiedHost.credentialsSaved ? 'Continue' : 'Retry saving credentials'}
                </Text>
              </Pressable>
              <Pressable
                style={styles.secondaryButton}
                accessibilityRole="button"
                accessibilityLabel="Back to home"
                onPress={cancel}
              >
                <Text style={styles.secondaryButtonText}>Back to home</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}
