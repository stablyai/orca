import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import type { MobileFileMedia } from './mobile-file-media'
import { downloadMobileFileMedia } from './mobile-file-media-download'
import { createMobileMediaSink } from './mobile-media-preview-cache'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { formatPreviewByteLength } from './mobile-file-preview-response'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'

type State =
  | { status: 'idle' }
  | { status: 'downloading'; bytes: number; total: number }
  | { status: 'ready'; uri: string }
  | { status: 'error'; message: string }

type Props = { media: MobileFileMedia; client: MobileFilePreviewRpcSender | null; title: string }

export function MobilePdfHandoff(props: Props) {
  const { media, client, title } = props
  const [state, setState] = useState<State>({ status: 'idle' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!client) {
      return
    }
    const controller = new AbortController()
    let sink: ReturnType<typeof createMobileMediaSink> | null = null
    setState({ status: 'downloading', bytes: 0, total: 0 })
    void (async () => {
      try {
        sink = createMobileMediaSink(media.relativePath, media.mimeType)
        const uri = await downloadMobileFileMedia(
          client,
          media,
          sink,
          controller.signal,
          (bytes, total) => setState({ status: 'downloading', bytes, total })
        )
        if (!controller.signal.aborted) {
          setState({ status: 'ready', uri })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to load PDF'
          })
        }
      }
    })()
    return () => {
      controller.abort()
      sink?.dispose()
    }
  }, [client, media, attempt])

  if (!client) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>Waiting for desktop...</Text>
      </View>
    )
  }
  if (state.status === 'downloading') {
    return (
      <View style={styles.state}>
        <ActivityIndicator color={colors.textSecondary} />
        <Text style={styles.stateText}>
          {state.total
            ? `Downloading ${formatPreviewByteLength(state.bytes)} of ${formatPreviewByteLength(state.total)}`
            : 'Loading PDF...'}
        </Text>
      </View>
    )
  }
  if (state.status === 'error') {
    return <MobileLoadErrorState message={state.message} onRetry={() => setAttempt(attempt + 1)} />
  }
  if (state.status === 'ready') {
    return (
      <View style={styles.state}>
        <Pressable
          style={styles.backButton}
          onPress={() => {
            void (async () => {
              const Sharing = await import('expo-sharing')
              await Sharing.shareAsync(state.uri, {
                mimeType: media.mimeType,
                dialogTitle: `Open ${title}`
              })
            })()
          }}
          accessibilityRole="button"
          accessibilityLabel="Open PDF"
        >
          <Text style={styles.stateText}>Open PDF</Text>
        </Pressable>
      </View>
    )
  }
  return null
}
