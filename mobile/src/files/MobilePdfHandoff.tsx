import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import type { MobileFileMedia } from './mobile-file-media'
import { downloadMobileFileMedia, type MobileMediaSink } from './mobile-file-media-download'
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
  // Downloaded PDF bytes are written to a temporary file before sharing.
  const { media: propMedia, client, title } = props
  const { worktreeId, relativePath, mimeType } = propMedia
  const [state, setState] = useState<State>({ status: 'idle' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!client) {
      return
    }
    const controller = new AbortController()
    const media: MobileFileMedia = { worktreeId, relativePath, mimeType }
    const parts: Uint8Array[] = []
    const sink: MobileMediaSink = {
      append: (bytes) => {
        parts.push(new Uint8Array(bytes))
      },
      finish: () => 'pending',
      dispose: () => {
        parts.length = 0
      }
    }
    let fileUri: string | null = null
    setState({ status: 'downloading', bytes: 0, total: 0 })
    void (async () => {
      try {
        await downloadMobileFileMedia(client, media, sink, controller.signal, (bytes, total) =>
          setState({ status: 'downloading', bytes, total })
        )
        if (controller.signal.aborted) {
          return
        }
        const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
        const bytes = new Uint8Array(total)
        let offset = 0
        for (const part of parts) {
          bytes.set(part, offset)
          offset += part.byteLength
        }
        parts.length = 0
        const FileSystem = await import('expo-file-system')
        if (controller.signal.aborted) {
          return
        }
        const safeName = (relativePath.split(/[/\\]/).pop() ?? 'document.pdf').replace(
          /[^a-zA-Z0-9._-]/g,
          '_'
        )
        const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const file = new FileSystem.File(
          FileSystem.Paths.cache,
          `orca-pdf-handoff-${unique}-${safeName}`
        )
        file.create({ overwrite: true })
        file.write(bytes)
        fileUri = file.uri
        if (!controller.signal.aborted) {
          setState({ status: 'ready', uri: fileUri })
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
      sink.dispose()
      if (fileUri) {
        try {
          const FileSystem = require('expo-file-system')
          new FileSystem.File(fileUri).delete()
        } catch {
          // Best effort cleanup.
        }
      }
    }
  }, [client, worktreeId, relativePath, mimeType, attempt])

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
                mimeType: mimeType,
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
