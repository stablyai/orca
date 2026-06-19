import { useCallback, useRef, useState } from 'react'
import { View, Text, StyleSheet, Pressable, ActivityIndicator, BackHandler } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { resolvePairConfirmRouteState } from '../src/transport/pair-confirm-state'
import {
  startPairingConnectionAttempt,
  type PairingConnectionAttempt
} from '../src/transport/pairing-connection-attempt'
import { connect } from '../src/transport/rpc-client'
import { saveHost, getNextHostName } from '../src/transport/host-store'
import type { ConnectionLogEntry, RpcResponse } from '../src/transport/types'
import { colors, spacing, radii, typography } from '../src/theme/mobile-theme'
import { ConnectionLog } from '../src/components/ConnectionLog'

type Status = 'awaiting-confirm' | 'connecting' | 'error'

// Why: cap how long the user stares at "Connecting…" during pairing.
// rpc-client retries forever by design (good for live sessions), but for
// the *initial* pair we want a hard ceiling so a half-broken Tailscale
// route surfaces an actionable error with the log visible, instead of
// spinning silently. ~25s allows for one full connect-timeout + a retry.
const PAIRING_OVERALL_TIMEOUT_MS = 25_000

export default function PairConfirmScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ code?: string }>()
  const [status, setStatus] = useState<Status>('awaiting-confirm')
  const [errorMessage, setErrorMessage] = useState('')
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([])
  // Why: collect logs in a ref so the rpc-client callback (which closures
  // over the initial state setter) always sees the freshest list and we
  // batch fewer setState calls when entries arrive in bursts.
  const logsRef = useRef<ConnectionLogEntry[]>([])
  const mountedRef = useRef(true)
  const activePairingAttemptRef = useRef<PairingConnectionAttempt | null>(null)

  const routeState = resolvePairConfirmRouteState(params.code)
  const offer = routeState.offer
  const resolvedStatus =
    status === 'awaiting-confirm' && routeState.kind === 'error' ? 'error' : status
  const resolvedErrorMessage =
    status === 'awaiting-confirm' && routeState.kind === 'error'
      ? routeState.errorMessage
      : errorMessage

  const cancel = useCallback(() => {
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
    // Why: pairing attempts can outlive the visible route; dispose them when
    // the confirm screen detaches without a passive cleanup-only Effect.
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
    let client: ReturnType<typeof connect> | null = null
    activePairingAttemptRef.current?.dispose()

    // Why: split the try/catch around the network call vs the local save
    // so a Keychain or AsyncStorage failure doesn't masquerade as a
    // "Cannot connect" error.
    let response: RpcResponse
    const attempt = startPairingConnectionAttempt({
      timeoutMs: PAIRING_OVERALL_TIMEOUT_MS,
      closeClient: () => client?.close()
    })
    activePairingAttemptRef.current = attempt
    try {
      client = connect(offer.endpoint, offer.deviceToken, offer.publicKeyB64, {
        onLog: (entry) => {
          if (!mountedRef.current || activePairingAttemptRef.current !== attempt) {
            return
          }
          logsRef.current = [...logsRef.current, entry]
          setLogs(logsRef.current)
        }
      })
      response = await client.sendRequest('status.get')
      const attemptIsCurrent = activePairingAttemptRef.current === attempt
      attempt.dispose()
      if (activePairingAttemptRef.current === attempt) {
        activePairingAttemptRef.current = null
      }
      if (!mountedRef.current || !attemptIsCurrent) {
        return
      }
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
          ? `Couldn't connect within ${PAIRING_OVERALL_TIMEOUT_MS / 1000}s — see log below for where it stalled`
          : 'Cannot connect — check that your computer is on the same network'
      )
      return
    }

    if (!response.ok) {
      if (!mountedRef.current) {
        return
      }
      setStatus('error')
      setErrorMessage(
        response.error.code === 'unauthorized'
          ? 'Authentication failed — token may be expired'
          : `Server error: ${response.error.message}`
      )
      return
    }

    try {
      const hostId = `host-${Date.now()}`
      const hostName = await getNextHostName()
      await saveHost({
        id: hostId,
        name: hostName,
        endpoint: offer.endpoint,
        deviceToken: offer.deviceToken,
        publicKeyB64: offer.publicKeyB64,
        lastConnected: Date.now()
      })
      if (!mountedRef.current) {
        return
      }
      router.replace(`/h/${hostId}`)
    } catch (err) {
      if (!mountedRef.current) {
        return
      }
      console.warn('[pair-confirm] save failed', err)
      setStatus('error')
      setErrorMessage(
        `Pairing succeeded but couldn't save the host: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  const containerPadding = { paddingTop: insets.top + spacing.sm }

  return (
    <View ref={setPairConfirmRootRef} style={[styles.container, containerPadding]}>
      <Pressable style={styles.backButton} onPress={cancel}>
        <ChevronLeft size={22} color={colors.textSecondary} />
      </Pressable>

      <View style={styles.content}>
        {offer && resolvedStatus === 'awaiting-confirm' && (
          <>
            <Text style={styles.title}>Pair with this desktop?</Text>
            <Text style={styles.subtitle}>
              You opened a pairing link from your desktop. Confirm to add it to your hosts.
            </Text>
            <View style={styles.actionStack}>
              <Pressable style={styles.primaryButton} onPress={() => void confirm()}>
                <Text style={styles.primaryButtonText}>Pair</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={cancel}>
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
            </View>
          </>
        )}

        {resolvedStatus === 'connecting' && (
          <>
            <ActivityIndicator size="large" color={colors.textSecondary} />
            <Text style={styles.connectingText}>Connecting…</Text>
            <View style={styles.logSlot}>
              <ConnectionLog entries={logs} title="Pairing log" />
            </View>
          </>
        )}

        {resolvedStatus === 'error' && (
          <>
            <Text style={styles.errorText}>{resolvedErrorMessage}</Text>
            {logs.length > 0 && (
              <View style={styles.logSlot}>
                <ConnectionLog entries={logs} title="Pairing log" />
              </View>
            )}
            <View style={styles.actionStack}>
              <Pressable style={styles.primaryButton} onPress={cancel}>
                <Text style={styles.primaryButtonText}>Back to home</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    // Why: nudges the centered group slightly above the geometric
    // middle so the eye reads it as visually centered above the home
    // indicator / nav bar.
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
    borderRadius: radii.button,
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
    borderRadius: radii.button,
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
})
