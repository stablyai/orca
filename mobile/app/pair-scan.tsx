import { useState, useRef, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Linking,
  type LayoutChangeEvent
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter } from 'expo-router'
import { ChevronLeft, Clipboard as ClipboardIcon, QrCode } from 'lucide-react-native'
import { decodePairingUrl, parsePairingCode } from '../src/transport/pairing'
import {
  startPreProfilePairing,
  type PreProfilePairingAttempt
} from '../src/transport/pre-profile-pairing-coordinator'
import type { ConnectionLogEntry, PairingOffer } from '../src/transport/types'
import { useRefreshHostClient } from '../src/transport/host-client-hooks'
import { colors, spacing } from '../src/theme/mobile-theme'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import { TextInputModal } from '../src/components/TextInputModal'
import { ConnectionLog } from '../src/components/ConnectionLog'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination
} from '../src/onboarding/mobile-onboarding-plan'
import { pairScanStyles as styles } from '../src/pair-scan-styles'

// Bound initial pairing at ~25s (one connect timeout plus retry) so broken routes show an actionable error/log; live RPC retries indefinitely.
const PAIRING_OVERALL_TIMEOUT_MS = 25_000
const SCAN_RETICLE_SCALE = 0.62
const SCAN_RETICLE_MAX_SIZE = 360

function Step({ number, text }: { number: number; text: string }) {
  useMobileColorScheme()
  return (
    <View style={styles.step}>
      <View style={styles.stepBadge}>
        <Text style={styles.stepNumber}>{number}</Text>
      </View>
      <Text style={styles.stepText}>{text}</Text>
    </View>
  )
}

export default function PairScanScreen() {
  useMobileColorScheme()
  const router = useRouter()
  const refreshHostClient = useRefreshHostClient()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const [status, setStatus] = useState<'scanning' | 'connecting' | 'error'>('scanning')
  const [errorMessage, setErrorMessage] = useState('')
  const [pasteVisible, setPasteVisible] = useState(false)
  const [cameraBounds, setCameraBounds] = useState({ width: 0, height: 0 })
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([])
  const logsRef = useRef<ConnectionLogEntry[]>([])
  const processingRef = useRef(false)
  const mountedRef = useRef(true)
  const activePairingAttemptRef = useRef<PreProfilePairingAttempt | null>(null)

  const setPairScanRootRef = useCallback((node: View | null): void => {
    if (node !== null) {
      mountedRef.current = true
      return
    }
    // Dispose pairing on route detach: attempts can outlive the visible screen, before passive cleanup.
    mountedRef.current = false
    activePairingAttemptRef.current?.dispose()
    activePairingAttemptRef.current = null
  }, [])

  const handleBarCodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (processingRef.current) {
        return
      }
      processingRef.current = true

      const offer = decodePairingUrl(data)
      if (!offer) {
        setStatus('error')
        setErrorMessage('Not a valid Orca QR code')
        processingRef.current = false
        return
      }

      void testAndSave(offer)
    },
    [router]
  )

  const handlePasteSubmit = useCallback((input: string) => {
    setPasteVisible(false)
    if (processingRef.current) {
      return
    }
    processingRef.current = true

    const offer = parsePairingCode(input)
    if (!offer) {
      setStatus('error')
      setErrorMessage('Not a valid pairing code — copy it from your computer and paste again')
      processingRef.current = false
      return
    }

    void testAndSave(offer)
  }, [])

  const handleCameraLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    const nextBounds = {
      width: Math.round(width),
      height: Math.round(height)
    }
    setCameraBounds((currentBounds) =>
      currentBounds.width === nextBounds.width && currentBounds.height === nextBounds.height
        ? currentBounds
        : nextBounds
    )
  }, [])

  async function testAndSave(offer: PairingOffer) {
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
      console.warn('[pair] connect failed', err)
      setStatus('error')
      setErrorMessage(
        timedOut
          ? `Couldn't connect within ${PAIRING_OVERALL_TIMEOUT_MS / 1000}s — see log below for where it stalled`
          : `Pairing failed: ${err instanceof Error ? err.message : String(err)}`
      )
      processingRef.current = false
    }
  }

  function retry() {
    setStatus('scanning')
    setErrorMessage('')
    logsRef.current = []
    setLogs([])
    processingRef.current = false
  }

  // Include Android three-button/iOS home-indicator inset so paste button stays clear.
  const containerPadding = {
    paddingTop: insets.top + spacing.sm,
    paddingBottom: insets.bottom + spacing.sm
  }
  // Keep QR guide square even on rectangular iPad previews.
  const reticleSize = Math.min(
    Math.round(Math.min(cameraBounds.width, cameraBounds.height) * SCAN_RETICLE_SCALE),
    SCAN_RETICLE_MAX_SIZE
  )

  if (!permission) {
    return (
      <View ref={setPairScanRootRef} style={[styles.container, containerPadding]}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }

  if (!permission.granted) {
    const canAskAgain = permission.canAskAgain !== false
    return (
      <View ref={setPairScanRootRef} style={[styles.container, containerPadding]}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <View style={styles.centered}>
          <Text style={styles.title}>
            {canAskAgain ? 'Pair with desktop' : 'Camera Access Disabled'}
          </Text>
          <Text style={styles.subtitle}>
            {canAskAgain
              ? 'Scan the QR code from Orca on your desktop, or paste the pairing code instead.'
              : 'Enable camera access in Settings, or paste the pairing code instead.'}
          </Text>
          <Pressable
            style={styles.primaryButton}
            onPress={canAskAgain ? requestPermission : () => void Linking.openSettings()}
          >
            {canAskAgain && <QrCode size={16} color={colors.bgBase} />}
            <Text style={styles.primaryButtonText}>
              {canAskAgain ? 'Continue' : 'Open Settings'}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.pasteButton, pressed && styles.pasteButtonPressed]}
            onPress={() => setPasteVisible(true)}
          >
            <ClipboardIcon size={16} color={colors.textSecondary} />
            <Text style={styles.pasteButtonText}>Paste code instead</Text>
          </Pressable>
        </View>
        <TextInputModal
          visible={pasteVisible}
          title="Paste pairing code"
          message="Copy the code shown under the QR on your computer."
          placeholder="orca://pair?code=... or paste the code"
          onSubmit={handlePasteSubmit}
          onCancel={() => setPasteVisible(false)}
        />
      </View>
    )
  }

  return (
    <View ref={setPairScanRootRef} style={[styles.container, containerPadding]}>
      <Pressable
        style={styles.backButton}
        onPress={() => router.back()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <ChevronLeft size={22} color={colors.textSecondary} />
      </Pressable>

      <View style={styles.steps}>
        <Step number={1} text="Open Orca on your computer" />
        <Step number={2} text="Go to Settings → Mobile" />
        <Step number={3} text="Scan the QR code" />
      </View>

      {status === 'scanning' && (
        <>
          {/* Pause camera behind paste sheet to save power and prevent unnoticed scans. */}
          {!pasteVisible && (
            <View style={styles.cameraWrap} onLayout={handleCameraLayout}>
              <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={handleBarCodeScanned}
              />
              <View style={styles.reticle} pointerEvents="none">
                <View style={[styles.reticleFrame, { width: reticleSize, height: reticleSize }]}>
                  <View style={[styles.corner, styles.cornerTL]} />
                  <View style={[styles.corner, styles.cornerTR]} />
                  <View style={[styles.corner, styles.cornerBL]} />
                  <View style={[styles.corner, styles.cornerBR]} />
                </View>
              </View>
            </View>
          )}
          {pasteVisible && <View style={styles.cameraPlaceholder} />}
          <Pressable
            style={({ pressed }) => [styles.pasteButton, pressed && styles.pasteButtonPressed]}
            onPress={() => setPasteVisible(true)}
          >
            <ClipboardIcon size={16} color={colors.textSecondary} />
            <Text style={styles.pasteButtonText}>Or paste pairing code</Text>
          </Pressable>
        </>
      )}

      {status === 'connecting' && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.textSecondary} />
          <Text style={styles.connectingText}>Connecting…</Text>
          <View style={styles.logSlot}>
            <ConnectionLog entries={logs} title="Pairing log" />
          </View>
        </View>
      )}

      {status === 'error' && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{errorMessage}</Text>
          {logs.length > 0 && (
            <View style={styles.logSlot}>
              <ConnectionLog entries={logs} title="Pairing log" />
            </View>
          )}
          <View style={styles.errorActions}>
            <Pressable style={styles.primaryButton} onPress={retry}>
              <Text style={styles.primaryButtonText}>Try Again</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.pasteButtonPressed
              ]}
              onPress={() => {
                retry()
                setPasteVisible(true)
              }}
            >
              <Text style={styles.secondaryButtonText}>Paste code instead</Text>
            </Pressable>
          </View>
        </View>
      )}

      <TextInputModal
        visible={pasteVisible}
        title="Paste pairing code"
        message="Copy the code shown under the QR on your computer."
        placeholder="orca://pair?code=... or paste the code"
        onSubmit={handlePasteSubmit}
        onCancel={() => setPasteVisible(false)}
      />
    </View>
  )
}
