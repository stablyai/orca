import { useCallback, useRef, useState } from 'react'
import { View, Text, StyleSheet, Pressable, ActivityIndicator, BackHandler } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import type { ConnectionRoute } from '../src/transport/connection-route'
import { resolvePairConfirmRouteState } from '../src/transport/pair-confirm-state'
import {
  startPreProfilePairing,
  type PreProfilePairingAttempt
} from '../src/transport/pre-profile-pairing-coordinator'
import type { ConnectionLogEntry } from '../src/transport/types'
import { useRefreshHostClient } from '../src/transport/client-context'
import { colors, spacing, radii, typography } from '../src/theme/mobile-theme'
import { ConnectionLog } from '../src/components/ConnectionLog'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination
} from '../src/onboarding/mobile-onboarding-plan'
import { routeFromSshProfile, wsEndpointPort, type SshProfile } from '../src/ssh/ssh-profile'
import { loadSshProfiles } from '../src/ssh/ssh-profile-store'
import { clearRecalledPairingCode, rememberPairingCode } from '../src/transport/pairing-code-recall'

type Status = 'awaiting-confirm' | 'connecting' | 'error'

// Why: cap how long the user stares at "Connecting…" during pairing.
// rpc-client retries forever by design (good for live sessions), but for
// the *initial* pair we want a hard ceiling so a half-broken Tailscale
// route surfaces an actionable error with the log visible, instead of
// spinning silently. ~25s allows for one full connect-timeout + a retry.
const PAIRING_OVERALL_TIMEOUT_MS = 25_000

export default function PairConfirmScreen() {
  const router = useRouter()
  const refreshHostClient = useRefreshHostClient()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ code?: string }>()
  const [status, setStatus] = useState<Status>('awaiting-confirm')
  const [errorMessage, setErrorMessage] = useState('')
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([])
  const [profiles, setProfiles] = useState<SshProfile[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  // Why: collect logs in a ref so the rpc-client callback (which closures
  // over the initial state setter) always sees the freshest list and we
  // batch fewer setState calls when entries arrive in bursts.
  const logsRef = useRef<ConnectionLogEntry[]>([])
  const mountedRef = useRef(true)
  const activePairingAttemptRef = useRef<PreProfilePairingAttempt | null>(null)

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

  useFocusEffect(
    useCallback(() => {
      let current = true
      void loadSshProfiles()
        .then((entries) => {
          if (!current) {
            return
          }
          setProfiles(entries)
          // Drop the selection if its profile was deleted while we were away.
          setSelectedProfileId((selected) =>
            selected !== null && !entries.some((entry) => entry.id === selected) ? null : selected
          )
        })
        .catch(() => {})
      return () => {
        current = false
      }
    }, [])
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
    void rememberPairingCode(params.code ?? '').catch(() => {})
    setStatus('connecting')
    logsRef.current = []
    setLogs([])
    activePairingAttemptRef.current?.dispose()

    const selectedProfile = profiles.find((entry) => entry.id === selectedProfileId)
    const jumpProfile = selectedProfile?.jumpProfileId
      ? profiles.find((entry) => entry.id === selectedProfile.jumpProfileId)
      : undefined
    // Why: an unusable route must not escape as an unhandled rejection — the
    // screen is already on 'connecting' and would spin forever.
    let connectionRoute: ConnectionRoute | undefined
    try {
      connectionRoute = selectedProfile
        ? routeFromSshProfile(selectedProfile, wsEndpointPort(offer.endpoint), jumpProfile)
        : undefined
    } catch (error) {
      setStatus('error')
      setErrorMessage(
        `Cannot use this SSH connection: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }
    const attempt = startPreProfilePairing({
      offer,
      connectionRoute,
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
      // Why: re-pairing the same desktop now reuses its existing host id
      // (STA-1840 dedup), so a client cached under that id from an earlier
      // pairing would keep the stale endpoint/relay. Close it so the
      // Refresh any cached client from the newly persisted pairing profile.
      refreshHostClient(hostId)
      void clearRecalledPairingCode().catch(() => {})
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
          ? `Couldn't connect within ${PAIRING_OVERALL_TIMEOUT_MS / 1000}s — see log below for where it stalled`
          : `Pairing failed: ${err instanceof Error ? err.message : String(err)}`
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
            <View style={styles.routeStack}>
              <Text style={styles.routeLabel}>Connection route</Text>
              <Pressable
                style={styles.routeRow}
                accessibilityRole="button"
                onPress={() => setSelectedProfileId(null)}
              >
                <Text style={styles.routeText}>Direct connection</Text>
                {selectedProfileId === null && <Text style={styles.routeCheck}>✓</Text>}
              </Pressable>
              {profiles.map((profile) => (
                <Pressable
                  key={profile.id}
                  style={styles.routeRow}
                  accessibilityRole="button"
                  onPress={() => setSelectedProfileId(profile.id)}
                >
                  <View style={styles.routeTextStack}>
                    <Text style={styles.routeText}>Through SSH: {profile.name}</Text>
                    <Text style={styles.routeDetail}>
                      {profile.username}@{profile.host}:{profile.port}
                    </Text>
                  </View>
                  {selectedProfileId === profile.id && <Text style={styles.routeCheck}>✓</Text>}
                </Pressable>
              ))}
              <Pressable
                style={styles.secondaryButton}
                onPress={() => router.push('/ssh-connections')}
              >
                <Text style={styles.secondaryButtonText}>Set up SSH connections</Text>
              </Pressable>
            </View>
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
              <Pressable
                style={styles.primaryButton}
                onPress={() => {
                  setStatus('awaiting-confirm')
                  setErrorMessage('')
                  void confirm()
                }}
              >
                <Text style={styles.primaryButtonText}>Try again</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={cancel}>
                <Text style={styles.secondaryButtonText}>Back to home</Text>
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
  routeStack: {
    width: '100%',
    maxWidth: 360,
    alignSelf: 'center',
    marginBottom: spacing.lg
  },
  routeLabel: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    marginBottom: spacing.sm
  },
  routeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginBottom: spacing.sm,
    gap: spacing.md
  },
  routeTextStack: { flex: 1 },
  routeText: { color: colors.textPrimary, fontSize: typography.bodySize },
  routeDetail: { color: colors.textSecondary, fontSize: typography.metaSize, marginTop: 2 },
  routeCheck: { color: colors.textSecondary, fontSize: typography.bodySize, fontWeight: '600' },
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
