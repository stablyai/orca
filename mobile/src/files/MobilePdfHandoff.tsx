import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'
import { useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import { colors } from '../theme/mobile-theme'
import type { MobileFileMedia } from './mobile-file-media'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

type Props = { media: MobileFileMedia; title: string }

type State = { status: 'idle' | 'opening' | 'opened' } | { status: 'error' }

export function MobilePdfHandoff({ media, title }: Props) {
  const verbs = useNativeVerbs()
  const [state, setState] = useState<State>({ status: 'idle' })

  // Older shells have no hand-off verb; say so instead of failing after a download the page cannot finish.
  if (!verbs.canShareFile) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>Update the Orca app to open PDFs on this device.</Text>
      </View>
    )
  }

  function openPdf(): void {
    setState({ status: 'opening' })
    void verbs
      .shareFile({
        worktreeId: media.worktreeId,
        relativePath: media.relativePath,
        mimeType: media.mimeType,
        title
      })
      .then(() => setState({ status: 'opened' }))
      .catch(() => setState({ status: 'error' }))
  }

  if (state.status === 'error') {
    return (
      <MobileLoadErrorState
        message="This PDF could not be opened. Check the desktop connection and try again."
        onRetry={openPdf}
      />
    )
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
      {state.status === 'opened' ? (
        <Text style={styles.stateText}>Opened in your PDF viewer.</Text>
      ) : null}
      <Pressable
        style={styles.pdfOpenButton}
        onPress={openPdf}
        accessibilityRole="button"
        accessibilityLabel="Open PDF"
      >
        <Text style={styles.stateText}>Open PDF</Text>
      </Pressable>
    </View>
  )
}
