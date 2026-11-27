import * as reticle from '../src/pairing/pairing-scan-reticle-dimensions'
import { useState, useRef, useCallback, useEffect } from 'react'
import {
  AppState,
  View,
  Text,
  Pressable,
  Linking,
  ScrollView,
  StyleSheet,
  type LayoutChangeEvent
} from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter } from 'expo-router'
import {
  CameraOff,
  ChevronLeft,
  CircleAlert,
  Clipboard as ClipboardIcon
} from 'lucide-react-native'
import { decodePairingUrl, parsePairingCode } from '../src/pairing/pairing'
import { getPairingScanErrorMessage } from '../src/pairing/pairing-scan-error-message'
import { takePastedPairingCode } from '../src/pairing/pasted-pairing-code'
import {
  startPreProfilePairing,
  type PreProfilePairingAttempt
} from '../src/pairing/pre-profile-pairing-coordinator'
import type { ConnectionLogEntry } from '../src/diagnostics/connection/connection-log-types'
import { formatConnectionLogHistory } from '../src/diagnostics/connection-diagnostics-report'
import type { PairingOffer } from '../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { useRefreshHostClient } from '../src/transport/connection/host-client-hooks'
import { spacing, pressedStyle } from '../src/theme/mobile-theme'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import { TextInputModal } from '../src/components/sheets/TextInputModal'
import { NavBar } from '../src/components/nav-bar/NavBar'
import { NavBarButton } from '../src/components/nav-bar/NavBarButton'
import { MobileStateView } from '../src/components/feedback/MobileStateView'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination
} from '../src/onboarding/mobile-onboarding-plan'
import { CAMERA_INK, pairScanStyles as styles } from '../src/pair-scan-styles'
import {
  PAIRING_SUCCESS_HOLD_MS,
  PairingProgress,
  SCAN_DECODE_BEAT_MS,
  ScanReticle,
  waitForBeat
} from '../src/pairing/pairing-visuals'
import { triggerSuccess } from '../src/platform/haptics/haptics'
import { getPairingFailureMessage } from '../src/pairing/pairing-failure-message'

// Bound initial pairing at ~25s (one connect timeout plus retry) so broken routes show an actionable error/log; live RPC retries indefinitely.
const PAIRING_OVERALL_TIMEOUT_MS = 25_000

export default function PairScanScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const refreshHostClient = useRefreshHostClient()
  const insets = useSafeAreaInsets()
  // Feed's Paste code hands its code over in memory; it pairs without the camera.
  const [pastedCode] = useState(takePastedPairingCode)
  const [permission, requestPermission, getPermission] = useCameraPermissions()
  const [status, setStatus] = useState<'scanning' | 'connecting' | 'error'>(() =>
    pastedCode ? 'connecting' : 'scanning'
  )
  const [decoded, setDecoded] = useState(false)
  const [paired, setPaired] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [pasteVisible, setPasteVisible] = useState(false)
  const [cameraAsked, setCameraAsked] = useState(false)
  // Which way the last code came in, so a failure offers that way again first.
  const [lastCodePasted, setLastCodePasted] = useState(pastedCode !== null)
  const [cameraBounds, setCameraBounds] = useState({ width: 0, height: 0 })
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([])
  const logsRef = useRef<ConnectionLogEntry[]>([])
  const processingRef = useRef(false)
  const mountedRef = useRef(true)
  const activePairingAttemptRef = useRef<PreProfilePairingAttempt | null>(null)

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void getPermission().catch(() => {})
      }
    })
    return () => subscription.remove()
  }, [getPermission])

  const setPairScanRootRef = useCallback((node: unknown): void => {
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
      setLastCodePasted(false)

      const offer = decodePairingUrl(data)
      if (!offer) {
        setStatus('error')
        setErrorMessage(getPairingScanErrorMessage(data, t))
        processingRef.current = false
        return
      }

      setDecoded(true)
      void waitForBeat(SCAN_DECODE_BEAT_MS).then(() => testAndSave(offer))
    },
    [router, t]
  )

  const handlePasteSubmit = useCallback(
    (input: string) => {
      setPasteVisible(false)
      if (processingRef.current) {
        return
      }
      processingRef.current = true
      setLastCodePasted(true)
      // A new code’s failure must not show the last attempt’s log.
      logsRef.current = []
      setLogs([])

      const offer = parsePairingCode(input)
      if (!offer) {
        setStatus('error')
        setErrorMessage(
          t(
            'app.pairScan.invalidPairingCode',
            'Not a valid pairing code — copy it from your computer and paste again'
          )
        )
        processingRef.current = false
        return
      }

      void testAndSave(offer)
    },
    [t]
  )

  const pastedCodeHandledRef = useRef(false)
  useEffect(() => {
    if (pastedCode && !pastedCodeHandledRef.current) {
      pastedCodeHandledRef.current = true
      handlePasteSubmit(pastedCode)
    }
  }, [handlePasteSubmit, pastedCode])

  // Scan code already asked for the camera: the system prompt opens with the screen, no Continue page.
  const cameraUndecided = permission !== null && !permission.granted && permission.canAskAgain
  useEffect(() => {
    if (
      cameraUndecided &&
      !cameraAsked &&
      status === 'scanning' &&
      !pasteVisible &&
      !processingRef.current
    ) {
      void requestPermission()
        .catch(() => {})
        .finally(() => setCameraAsked(true))
    }
  }, [cameraAsked, cameraUndecided, pasteVisible, requestPermission, status])

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
    // A decoded QR waits out the reticle beat; the screen may have left meanwhile.
    if (!mountedRef.current) {
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
      console.warn('[pair] connect failed', err)
      setStatus('error')
      setErrorMessage(
        getPairingFailureMessage({
          screen: 'scan',
          error: err,
          timedOut,
          timeoutMs: PAIRING_OVERALL_TIMEOUT_MS,
          t
        })
      )
      processingRef.current = false
    }
  }

  function retry() {
    setStatus('scanning')
    setDecoded(false)
    setErrorMessage('')
    logsRef.current = []
    setLogs([])
    processingRef.current = false
  }

  // The sheet opens over whatever is showing; only submitting a code moves on.
  const pasteAction = {
    label: t('app.pairScan.pasteCode', 'Paste code'),
    onPress: () => setPasteVisible(true)
  }
  const scanAction = { label: t('app.pairScan.scanCode', 'Scan code'), onPress: retry }
  // Keep QR guide square even on rectangular iPad previews.
  const reticleSize = Math.min(
    Math.round(Math.min(cameraBounds.width, cameraBounds.height) * reticle.SCALE),
    reticle.MAX_SIZE
  )

  let body
  if (status === 'connecting') {
    body = (
      <View style={[styles.centered, { paddingBottom: insets.bottom }]}>
        <PairingProgress
          succeeded={paired}
          connectingLabel={t('app.pairScan.connecting', 'Connecting…')}
          labelStyle={styles.connectingText}
        />
      </View>
    )
  } else if (status === 'error') {
    // Scrolls so an opened log never pushes the actions off screen.
    body = (
      <ScrollView contentContainerStyle={styles.scrollFill}>
        <MobileStateView
          icon={CircleAlert}
          title={t('app.pairScan.couldNotPair', 'Couldn’t pair')}
          message={errorMessage}
          details={logs.length > 0 ? formatConnectionLogHistory(logs) : null}
          secondaryAction={lastCodePasted ? scanAction : pasteAction}
          action={
            lastCodePasted
              ? pasteAction
              : { label: t('app.pairScan.retry', 'Try again'), onPress: retry }
          }
          bottomInset={insets.bottom}
        />
      </ScrollView>
    )
  } else if (permission && !permission.granted && (!permission.canAskAgain || cameraAsked)) {
    body = (
      <MobileStateView
        icon={CameraOff}
        title={t('app.pairScan.cameraOff', 'Camera is off')}
        message={t(
          'app.pairScan.allowCameraOrPaste',
          'Allow the camera to scan, or paste the code.'
        )}
        secondaryAction={pasteAction}
        action={
          permission.canAskAgain
            ? {
                label: t('app.pairScan.allowCamera', 'Allow camera'),
                onPress: () => void requestPermission()
              }
            : {
                label: t('app.pairScan.openSettings', 'Open Settings'),
                onPress: () => void Linking.openSettings()
              }
        }
        bottomInset={insets.bottom}
      />
    )
  } else {
    body = (
      <View style={styles.camera} onLayout={handleCameraLayout}>
        {/* Pause camera behind paste sheet to save power and prevent unnoticed scans. */}
        {permission?.granted && !pasteVisible ? (
          <>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleBarCodeScanned}
            />
            <ScanReticle size={reticleSize} decoded={decoded} />
          </>
        ) : null}
        <View style={[styles.cameraFoot, { paddingBottom: insets.bottom + spacing.lg }]}>
          <CameraFootFade />
          <Text style={styles.cameraHint}>
            {t('app.pairScan.pointAtCode', 'Point at the code in Orca on your computer')}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.cameraPaste, pressed && pressedStyle]}
            onPress={() => setPasteVisible(true)}
            accessibilityRole="button"
          >
            <ClipboardIcon size={17} color={CAMERA_INK} strokeWidth={2} />
            <Text style={styles.cameraPasteLabel}>{pasteAction.label}</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View ref={setPairScanRootRef} style={[styles.container, { paddingTop: insets.top }]}>
      <NavBar
        leading={
          <NavBarButton
            icon={ChevronLeft}
            accessibilityLabel={t('common.back', 'Back')}
            onPress={() => router.back()}
          />
        }
        title={status === 'scanning' ? t('app.pairScan.scanCode', 'Scan code') : undefined}
      />
      {body}
      <TextInputModal
        visible={pasteVisible}
        title={t('app.pairScan.pasteCodeTitle', 'Paste pairing code')}
        message={t(
          'app.pairScan.pasteCodeMessage',
          'Copy the code shown under the QR on your computer.'
        )}
        placeholder={t(
          'app.pairScan.pasteCodePlaceholder',
          'orca://pair?code=... or paste the code'
        )}
        onSubmit={handlePasteSubmit}
        onCancel={() => setPasteVisible(false)}
      />
    </View>
  )
}

// The camera never takes the app's theme: what sits on it is light text over a dark fade.
function CameraFootFade() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="pair-scan-foot-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000000" stopOpacity={0} />
            <Stop offset="1" stopColor="#000000" stopOpacity={0.6} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#pair-scan-foot-fade)" />
      </Svg>
    </View>
  )
}
