import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { ActivityIndicator, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { usePdfOpener } from '../platform/pdf-opener'
import { PdfOpenRefusedError } from '../platform/pdf-opener-contract'
import type { MobileFileMedia } from './mobile-file-media'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { MobileLoadErrorState, MobileStateButton } from '../components/MobileLoadErrorState'

type State =
  | { status: 'opening' }
  | { status: 'idle' }
  | { status: 'failed'; message: string; retryable: boolean }

// The shell downloads the PDF and shows it in Quick Look (iOS) or the system viewer (Android).
export function MobilePdfPreview({ media }: { media: MobileFileMedia }) {
  useMobileColorScheme()
  const opener = usePdfOpener()
  const [state, setState] = useState<State>({ status: 'idle' })
  const stopPending = useRef<(() => void) | null>(null)
  // Open only on a tap: this also mounts on hidden screens and after reconnects, where a viewer must not appear.
  const open = () => {
    if (!opener) {
      return
    }
    stopPending.current?.()
    let pending = true
    const settle = (next: State) => {
      if (pending) {
        pending = false
        setState(next)
      }
    }
    stopPending.current = () => {
      if (pending) {
        opener.cancel()
      }
      settle({ status: 'idle' })
    }
    setState({ status: 'opening' })
    opener.open({ worktreeId: media.worktreeId, relativePath: media.relativePath }).then(
      () => settle({ status: 'idle' }),
      (error: unknown) =>
        settle({
          status: 'failed',
          message: error instanceof Error ? error.message : 'Unable to open this PDF',
          retryable: !(error instanceof PdfOpenRefusedError)
        })
    )
  }
  // Hidden stack screens stay mounted, so blur as well as unmount stops an open still downloading.
  useFocusEffect(useCallback(() => () => stopPending.current?.(), []))
  if (!opener) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>Update Orca Mobile to open PDFs</Text>
      </View>
    )
  }
  if (state.status === 'failed') {
    return <MobileLoadErrorState message={state.message} onRetry={state.retryable ? open : null} />
  }
  if (state.status === 'opening') {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={colors.textSecondary} />
        <Text style={styles.stateText}>Opening PDF...</Text>
      </View>
    )
  }
  return (
    <View style={styles.state}>
      <MobileStateButton label="Open PDF" onPress={open} />
    </View>
  )
}
