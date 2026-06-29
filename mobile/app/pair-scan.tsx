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
  startPairingConnectionAttempt,
  type PairingConnectionAttempt
} from '../src/transport/pairing-connection-attempt'
import { connect } from '../src/transport/rpc-client'
import { saveHost, getNextHostName } from '../src/transport/host-store'
import type { ConnectionLogEntry, PairingOffer, RpcResponse } from '../src/transport/types'
import { colors, spacing } from '../src/theme/mobile-theme'
import { TextInputModal } from '../src/components/TextInputModal'
import { ConnectionLog } from '../src/components/ConnectionLog'
import { useTranslate } from '../src/i18n/useTranslate'
import { pairScanStyles as styles } from './pair-scan-styles'

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
  const insets = useSafeAreaInsets()
  const { t } = useTranslate()
  const [permission, requestPermission] = useCameraPermissions()
  const [status, setStatus] = useState<'scanning' | 'connecting' | 'error'>('scanning')
  const [errorMessage, setErrorMessage] = useState('')
  const [pasteVisible, setPasteVisible] = useState(false)
  const [cameraBounds, setCameraBounds] = useState({ width: 0, height: 0 })
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([])
  const logsRef = useRef<ConnectionLogEntry[]>([])
  const processingRef = useRef(false)
  const mountedRef = useRef(true)
  const activePairingAttemptRef = useRef<PairingConnectionAttempt | null>(null)

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
        setStatus('error')
        setErrorMessage(t('mobile.pair.invalidQr', 'Not a valid Orca QR code'))
        processingRef.current = false
        return
      }

      void testAndSave(offer)
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

      const offer = parsePairingCode(input)
      if (!offer) {
        setStatus('error')
        setErrorMessage(
          t(
            'mobile.pair.invalidPasteCode',
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
    let client: ReturnType<typeof connect> | null = null
    activePairingAttemptRef.current?.dispose()

    // Why: split the try/catch around the network call vs the local save
    // so a Keychain or AsyncStorage failure doesn't masquerade as a
    // "Cannot connect — same network?" error. Pairing reached the
    // desktop fine; the failure is local persistence.
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
      console.warn('[pair] connect failed', err)
      setStatus('error')
      setErrorMessage(
        timedOut
          ? t(
              'mobile.pair.connectTimeout',
              "Couldn't connect within {{seconds}}s — see log below for where it stalled",
              {
                seconds: PAIRING_OVERALL_TIMEOUT_MS / 1000
              }
            )
          : t(
              'mobile.pair.cannotConnectNetwork',
              'Cannot connect — check that your computer is on the same network'
            )
      )
      processingRef.current = false
      return
    }

    if (!response.ok) {
      if (!mountedRef.current) {
        return
      }
      if (response.error.code === 'unauthorized') {
        setStatus('error')
        setErrorMessage(t('mobile.pair.authFailed', 'Authentication failed — token may be expired'))
        processingRef.current = false
        return
      }
      setStatus('error')
      setErrorMessage(
        t('mobile.pair.serverError', 'Server error: {{message}}', {
          message: response.error.message
        })
      )
      processingRef.current = false
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
      console.warn('[pair] save failed', err)
      setStatus('error')
      setErrorMessage(
        t(
          'mobile.pair.saveHostFailed',
          "Pairing succeeded but couldn't save the host: {{message}}",
          {
            message: err instanceof Error ? err.message : String(err)
          }
        )
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

  // Why: bottom inset accounts for Android 3-button nav bars and iOS
  // home-indicator areas that would otherwise overlap the 'Or paste
  // pairing code' button at the bottom of the scan screen.
  const containerPadding = {
    paddingTop: insets.top + spacing.sm,
    paddingBottom: insets.bottom + spacing.sm
  }
  // Why: iPad camera previews are often rectangular, but QR guides should
  // stay square so the corners still describe the code shape.
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
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <View style={styles.centered}>
          <Text style={styles.title}>
            {canAskAgain
              ? t('mobile.pair.pairDesktop', 'Pair with desktop')
              : t('mobile.pair.cameraDisabled', 'Camera Access Disabled')}
          </Text>
          <Text style={styles.subtitle}>
            {canAskAgain
              ? t(
                  'mobile.pair.scanDesktopHint',
                  'Scan the QR code from Orca on your desktop, or paste the pairing code instead.'
                )
              : t(
                  'mobile.pair.enableCameraHint',
                  'Enable camera access in Settings, or paste the pairing code instead.'
                )}
          </Text>
          <Pressable
            style={styles.primaryButton}
            onPress={canAskAgain ? requestPermission : () => void Linking.openSettings()}
          >
            {canAskAgain && <QrCode size={16} color={colors.bgBase} />}
            <Text style={styles.primaryButtonText}>
              {canAskAgain
                ? t('mobile.pair.continue', 'Continue')
                : t('mobile.pair.openDeviceSettings', 'Open Settings')}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.pasteButton, pressed && styles.pasteButtonPressed]}
            onPress={() => setPasteVisible(true)}
          >
            <ClipboardIcon size={16} color={colors.textSecondary} />
            <Text style={styles.pasteButtonText}>
              {t('mobile.pair.pasteCode', 'Paste code instead')}
            </Text>
          </Pressable>
        </View>
        <TextInputModal
          visible={pasteVisible}
          title={t('mobile.pair.pasteTitle', 'Paste pairing code')}
          message={t(
            'mobile.pair.pasteMessage',
            'Copy the code shown under the QR on your computer.'
          )}
          placeholder={t('mobile.pair.pastePlaceholder', 'orca://pair?code=... or paste the code')}
          onSubmit={handlePasteSubmit}
          onCancel={() => setPasteVisible(false)}
        />
      </View>
    )
  }

  return (
    <View ref={setPairScanRootRef} style={[styles.container, containerPadding]}>
      <Pressable style={styles.backButton} onPress={() => router.back()}>
        <ChevronLeft size={22} color={colors.textSecondary} />
      </Pressable>

      <View style={styles.steps}>
        <Step number={1} text={t('mobile.pair.step1Open', 'Open Orca on your computer')} />
        <Step number={2} text={t('mobile.pair.step2Settings', 'Go to Settings → Mobile')} />
        <Step number={3} text={t('mobile.pair.step3Scan', 'Scan the QR code')} />
      </View>

      {status === 'scanning' && (
        <>
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
          <Pressable
            style={({ pressed }) => [styles.pasteButton, pressed && styles.pasteButtonPressed]}
            onPress={() => setPasteVisible(true)}
          >
            <ClipboardIcon size={16} color={colors.textSecondary} />
            <Text style={styles.pasteButtonText}>
              {t('mobile.pair.orPasteCode', 'Or paste pairing code')}
            </Text>
          </Pressable>
        </>
      )}

      {status === 'connecting' && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.textSecondary} />
          <Text style={styles.connectingText}>{t('mobile.pair.connecting', 'Connecting…')}</Text>
          <View style={styles.logSlot}>
            <ConnectionLog entries={logs} title={t('mobile.pair.pairingLog', 'Pairing log')} />
          </View>
        </View>
      )}

      {status === 'error' && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{errorMessage}</Text>
          {logs.length > 0 && (
            <View style={styles.logSlot}>
              <ConnectionLog entries={logs} title={t('mobile.pair.pairingLog', 'Pairing log')} />
            </View>
          )}
          <View style={styles.errorActions}>
            <Pressable style={styles.primaryButton} onPress={retry}>
              <Text style={styles.primaryButtonText}>{t('mobile.pair.tryAgain', 'Try Again')}</Text>
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
              <Text style={styles.secondaryButtonText}>
                {t('mobile.pair.pasteCode', 'Paste code instead')}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      <TextInputModal
        visible={pasteVisible}
        title={t('mobile.pair.pasteTitle', 'Paste pairing code')}
        message={t(
          'mobile.pair.pasteMessage',
          'Copy the code shown under the QR on your computer.'
        )}
        placeholder={t('mobile.pair.pastePlaceholder', 'orca://pair?code=... or paste the code')}
        onSubmit={handlePasteSubmit}
        onCancel={() => setPasteVisible(false)}
      />
    </View>
  )
}
