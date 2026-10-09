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
import { useFocusEffect, useRouter } from 'expo-router'
import { ChevronLeft, Clipboard as ClipboardIcon, QrCode } from 'lucide-react-native'
import { decodePairingUrl, parsePairingCode } from '../src/transport/pairing'
import { loadRecalledPairingCode } from '../src/transport/pairing-code-recall'
import { colors, spacing } from '../src/theme/mobile-theme'
import { TextInputModal } from '../src/components/TextInputModal'
import { pairScanStyles as styles } from '../src/pair-scan-styles'

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
  const [permission, requestPermission] = useCameraPermissions()
  const [status, setStatus] = useState<'scanning' | 'error'>('scanning')
  const [errorMessage, setErrorMessage] = useState('')
  const [pasteVisible, setPasteVisible] = useState(false)
  const [cameraBounds, setCameraBounds] = useState({ width: 0, height: 0 })
  const [recalledCode, setRecalledCode] = useState<string | null>(null)
  const processingRef = useRef(false)

  // Why: the scanner keeps running behind pair-confirm; when the user comes
  // back (pair failed or was cancelled) the next scan must be accepted again.
  useFocusEffect(
    useCallback(() => {
      processingRef.current = false
      let current = true
      void loadRecalledPairingCode()
        .then((code) => {
          if (current) {
            setRecalledCode(code)
          }
        })
        // Why: a failed read only means there is no code to offer.
        .catch(() => {})
      return () => {
        current = false
      }
    }, [])
  )

  const handleBarCodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (processingRef.current) {
        return
      }
      processingRef.current = true

      if (!decodePairingUrl(data)) {
        setStatus('error')
        setErrorMessage('Not a valid Orca QR code')
        processingRef.current = false
        return
      }
      // Why: pair-confirm owns pairing and offers the SSH connection route,
      // so every entry path (QR, paste, deep link) gets the same choice.
      router.push({ pathname: '/pair-confirm', params: { code: data } })
    },
    [router]
  )

  const handlePasteSubmit = useCallback(
    (input: string) => {
      setPasteVisible(false)
      if (processingRef.current) {
        return
      }
      processingRef.current = true

      if (!parsePairingCode(input)) {
        setStatus('error')
        setErrorMessage('Not a valid pairing code — copy it from your computer and paste again')
        processingRef.current = false
        return
      }
      router.push({ pathname: '/pair-confirm', params: { code: input } })
    },
    [router]
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

  function retry() {
    setStatus('scanning')
    setErrorMessage('')
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
      <View style={[styles.container, containerPadding]}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }

  if (!permission.granted) {
    const canAskAgain = permission.canAskAgain !== false
    return (
      <View style={[styles.container, containerPadding]}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
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
        <Pressable
          style={styles.pasteButton}
          accessibilityRole="button"
          onPress={() => router.push('/ssh-connections')}
        >
          <Text style={styles.pasteButtonText}>Set up SSH connections</Text>
        </Pressable>
        {recalledCode && (
          <Pressable
            style={styles.pasteButton}
            accessibilityRole="button"
            onPress={() =>
              router.push({ pathname: '/pair-confirm', params: { code: recalledCode } })
            }
          >
            <Text style={styles.pasteButtonText}>Retry last pairing code</Text>
          </Pressable>
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

  return (
    <View style={[styles.container, containerPadding]}>
      <Pressable style={styles.backButton} onPress={() => router.back()}>
        <ChevronLeft size={22} color={colors.textSecondary} />
      </Pressable>

      {status === 'scanning' && (
        <Pressable
          style={styles.pasteButton}
          accessibilityRole="button"
          onPress={() => router.push('/ssh-connections')}
        >
          <Text style={styles.pasteButtonText}>Set up SSH connections</Text>
        </Pressable>
      )}

      <View style={styles.steps}>
        <Step number={1} text="Open Orca on your computer" />
        <Step number={2} text="Go to Settings → Mobile" />
        <Step number={3} text="Scan the QR code" />
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
            <Text style={styles.pasteButtonText}>Or paste pairing code</Text>
          </Pressable>
        </>
      )}

      {status === 'error' && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{errorMessage}</Text>
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
