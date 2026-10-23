import { useState, useRef, useCallback } from 'react'
import { View, Text, Linking, type LayoutChangeEvent } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter } from 'expo-router'
import { AlertCircle, CameraOff, Clipboard as ClipboardIcon, QrCode } from 'lucide-react-native'
import { decodePairingUrl, parsePairingCode } from '../src/transport/pairing'
import {
  startPreProfilePairing,
  type PreProfilePairingAttempt
} from '../src/transport/pre-profile-pairing-coordinator'
import type { ConnectionLogEntry, PairingOffer } from '../src/transport/types'
import { useRefreshHostClient } from '../src/transport/host-client-hooks'
import { hostEndpointLabel } from '../src/transport/host-endpoint-label'
import { colors } from '../src/theme/mobile-theme'
import { TextInputModal } from '../src/components/TextInputModal'
import { Button } from '../src/components/ui/Button'
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
import { pairScanStyles as styles } from '../src/pair-scan-styles'

// Why: see pair-confirm.tsx — cap initial-pair "Connecting…" so a broken
// route surfaces as a real error with the log visible instead of a
// silent infinite spinner.
const PAIRING_OVERALL_TIMEOUT_MS = 25_000
const SCAN_RETICLE_SCALE = 0.62
const SCAN_RETICLE_MAX_SIZE = 360

function Step({ number, text }: { number: number; text: string }) {
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
  const router = useRouter()
  const refreshHostClient = useRefreshHostClient()
  const [permission, requestPermission] = useCameraPermissions()
  const [status, setStatus] = useState<'scanning' | 'connecting' | 'error'>('scanning')
  const [errorMessage, setErrorMessage] = useState('')
  const [errorDetail, setErrorDetail] = useState('')
  const [connectingTo, setConnectingTo] = useState<string | null>(null)
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
    // Why: pairing attempts can outlive the visible route; dispose them when
    // the scan screen detaches without a passive cleanup-only Effect.
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
        triggerError()
        setStatus('error')
        setErrorMessage(
          "This QR code isn't an Orca pairing code. Scan the one in Orca's Settings → Mobile on your computer."
        )
        setErrorDetail('')
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
      triggerError()
      setStatus('error')
      setErrorMessage(INVALID_PAIRING_CODE_MESSAGE)
      setErrorDetail('')
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
    setConnectingTo(hostEndpointLabel(offer.endpoint))
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
      console.warn('[pair] connect failed', err)
      const failure = pairingFailure(err, timedOut, PAIRING_OVERALL_TIMEOUT_MS)
      triggerError()
      setStatus('error')
      setErrorMessage(failure.message)
      setErrorDetail(failure.detail)
      processingRef.current = false
    }
  }

  function retry() {
    setStatus('scanning')
    setErrorMessage('')
    setErrorDetail('')
    logsRef.current = []
    setLogs([])
    processingRef.current = false
  }

  // Why: iPad camera previews are often rectangular, but QR guides should
  // stay square so the corners still describe the code shape.
  const reticleSize = Math.min(
    Math.round(Math.min(cameraBounds.width, cameraBounds.height) * SCAN_RETICLE_SCALE),
    SCAN_RETICLE_MAX_SIZE
  )
  const close = () => router.back()
  const pasteModal = (
    <TextInputModal
      visible={pasteVisible}
      title="Paste pairing code"
      message="Copy the code shown under the QR code on your computer."
      placeholder="orca://pair?code=… or the code"
      submitLabel="Connect"
      onSubmit={handlePasteSubmit}
      onCancel={() => setPasteVisible(false)}
    />
  )

  if (!permission) {
    return (
      <PairingScreenFrame title="Pair a desktop" onCancel={close} rootRef={setPairScanRootRef}>
        <PairingMessage loading title="Opening the camera…" />
      </PairingScreenFrame>
    )
  }

  if (!permission.granted) {
    const canAskAgain = permission.canAskAgain !== false
    return (
      <PairingScreenFrame
        title="Pair a desktop"
        onCancel={close}
        rootRef={setPairScanRootRef}
        actions={
          <>
            <Button
              label={canAskAgain ? 'Continue' : 'Open Settings'}
              icon={canAskAgain ? QrCode : undefined}
              variant="primary"
              block
              onPress={canAskAgain ? requestPermission : () => void Linking.openSettings()}
            />
            <Button
              label="Paste code instead"
              icon={ClipboardIcon}
              variant="plain"
              block
              onPress={() => setPasteVisible(true)}
            />
          </>
        }
      >
        <PairingMessage
          icon={canAskAgain ? QrCode : CameraOff}
          title={canAskAgain ? 'Scan the QR code' : 'Camera access is off'}
          message={
            canAskAgain
              ? 'Orca uses the camera to read the QR code shown on your computer. You can paste the pairing code instead.'
              : 'Turn on camera access for Orca in Settings, or paste the pairing code instead.'
          }
        />
        {pasteModal}
      </PairingScreenFrame>
    )
  }

  return (
    <PairingScreenFrame
      title="Pair a desktop"
      onCancel={close}
      rootRef={setPairScanRootRef}
      actions={
        status === 'scanning' ? (
          <Button
            label="Paste pairing code"
            icon={ClipboardIcon}
            variant="plain"
            block
            onPress={() => setPasteVisible(true)}
          />
        ) : status === 'error' ? (
          <>
            <Button label="Try again" variant="primary" block onPress={retry} />
            <Button
              label="Paste code instead"
              icon={ClipboardIcon}
              variant="plain"
              block
              onPress={() => {
                retry()
                setPasteVisible(true)
              }}
            />
          </>
        ) : undefined
      }
    >
      {status === 'scanning' && (
        <>
          <View style={styles.steps}>
            <Step number={1} text="Open Orca on your computer" />
            <Step number={2} text="Go to Settings → Mobile" />
            <Step number={3} text="Point this camera at the QR code" />
          </View>
          {/* Why: unmount the camera while the paste sheet is open. The
              user has clearly chosen the paste path; keeping the camera
              streaming behind a sheet wastes power and looks weird if
              they cancel the sheet and the QR was scanned silently in
              the meantime. */}
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
        </>
      )}

      {status === 'connecting' && (
        <PairingMessage
          loading
          title={connectingTo ? `Connecting to ${connectingTo}…` : 'Connecting…'}
          message="This usually takes a few seconds."
        >
          <PairingDetails logs={logs} />
        </PairingMessage>
      )}

      {status === 'error' && (
        <PairingMessage
          icon={AlertCircle}
          iconColor={colors.danger}
          title="Couldn't pair"
          message={errorMessage}
        >
          <PairingDetails detail={errorDetail || undefined} logs={logs} />
        </PairingMessage>
      )}

      {pasteModal}
    </PairingScreenFrame>
  )
}
