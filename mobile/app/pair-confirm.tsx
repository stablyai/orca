import { useCallback, useRef, useState } from 'react'
import { BackHandler, StyleSheet, type View } from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { AlertCircle, Monitor } from 'lucide-react-native'
import { resolvePairConfirmRouteState } from '../src/transport/pair-confirm-state'
import {
  startPreProfilePairing,
  type PreProfilePairingAttempt
} from '../src/transport/pre-profile-pairing-coordinator'
import type { ConnectionLogEntry } from '../src/transport/types'
import { useRefreshHostClient } from '../src/transport/host-client-hooks'
import { hostEndpointLabel } from '../src/transport/host-endpoint-label'
import { colors, spacing } from '../src/theme/mobile-theme'
import { Button } from '../src/components/ui/Button'
import { ListGroup } from '../src/components/ui/ListGroup'
import { ListRow } from '../src/components/ui/ListRow'
import { triggerError, triggerSuccess } from '../src/platform/haptics'
import {
  INVALID_PAIRING_CODE_MESSAGE,
  PairingDetails,
  PairingMessage,
  PairingScreenFrame,
  pairingFailure
} from '../src/pairing-screen-frame'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination
} from '../src/onboarding/mobile-onboarding-plan'

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
  const params = useLocalSearchParams<{ code?: string }>()
  const [status, setStatus] = useState<Status>('awaiting-confirm')
  const [errorMessage, setErrorMessage] = useState('')
  const [errorDetail, setErrorDetail] = useState('')
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([])
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
      // Why: re-pairing the same desktop now reuses its existing host id
      // (STA-1840 dedup), so a client cached under that id from an earlier
      // pairing would keep the stale endpoint/relay. Close it so the
      // Refresh any cached client from the newly persisted pairing profile.
      refreshHostClient(hostId)
      const onboardingSteps = await loadMobileOnboardingSteps()
      if (!mountedRef.current) {
        return
      }
      triggerSuccess()
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
      const failure = pairingFailure(err, timedOut, PAIRING_OVERALL_TIMEOUT_MS)
      triggerError()
      setStatus('error')
      setErrorMessage(failure.message)
      setErrorDetail(failure.detail)
    }
  }

  const address = offer ? hostEndpointLabel(offer.endpoint) : null
  const routeErrorMessage = params.code
    ? INVALID_PAIRING_CODE_MESSAGE
    : "This link didn't include a pairing code. Scan the QR code from Orca on your computer instead."

  return (
    <PairingScreenFrame
      title="Pair a desktop"
      onCancel={cancel}
      rootRef={setPairConfirmRootRef}
      actions={
        resolvedStatus === 'awaiting-confirm' && offer ? (
          <>
            <Button label="Pair" variant="primary" block onPress={() => void confirm()} />
            <Button label="Cancel" variant="plain" block onPress={cancel} />
          </>
        ) : resolvedStatus === 'error' ? (
          offer ? (
            <>
              <Button label="Try again" variant="primary" block onPress={() => void confirm()} />
              <Button label="Back to home" variant="plain" block onPress={cancel} />
            </>
          ) : (
            <Button label="Back to home" variant="primary" block onPress={cancel} />
          )
        ) : undefined
      }
    >
      {offer && resolvedStatus === 'awaiting-confirm' && (
        <PairingMessage
          icon={Monitor}
          title="Pair with this desktop?"
          message="You opened a pairing link from Orca on your computer. Pairing lets this phone open its workspaces."
        >
          {address ? (
            <ListGroup style={styles.offer}>
              <ListRow
                title={address}
                subtitle="Desktop address"
                titleNumberOfLines={2}
                testID="pair-confirm-address"
              />
            </ListGroup>
          ) : null}
        </PairingMessage>
      )}

      {resolvedStatus === 'connecting' && (
        <PairingMessage
          loading
          title={address ? `Connecting to ${address}…` : 'Connecting…'}
          message="This usually takes a few seconds."
        >
          <PairingDetails logs={logs} />
        </PairingMessage>
      )}

      {resolvedStatus === 'error' && (
        <PairingMessage
          icon={AlertCircle}
          iconColor={colors.danger}
          title="Couldn't pair"
          message={status === 'error' ? errorMessage : routeErrorMessage}
        >
          <PairingDetails detail={status === 'error' ? errorDetail : undefined} logs={logs} />
        </PairingMessage>
      )}
    </PairingScreenFrame>
  )
}

const styles = StyleSheet.create({
  // Why: the shared group insets itself from the screen edge; the pairing column already does.
  offer: { alignSelf: 'stretch', marginHorizontal: 0, marginTop: spacing.md }
})
