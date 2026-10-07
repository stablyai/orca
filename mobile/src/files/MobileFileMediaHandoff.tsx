import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ExternalLink } from 'lucide-react-native'
import * as Sharing from 'expo-sharing'
import { colors } from '../theme/mobile-theme'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import {
  createMobileFileMediaAttempt,
  downloadMobileFileMedia,
  type MobileFileMediaAttempt
} from './mobile-file-media-handoff'
import { mediaHandoffSinkFor } from './mobile-file-media-handoff-device'
import { formatPreviewByteLength } from './mobile-file-preview-response'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

type Props = {
  client: MobileFilePreviewRpcSender | null
  connected: boolean
  mimeType: string
  relativePath: string
  title: string
  worktreeId: string
}

/** The body a PDF or media file renders: no in-phone renderer, so the bytes go to the OS. */
export function MobileFileMediaHandoff({
  client,
  connected,
  mimeType,
  relativePath,
  title,
  worktreeId
}: Props) {
  const [downloading, setDownloading] = useState(false)
  const [progressBytes, setProgressBytes] = useState(0)
  const [message, setMessage] = useState('')
  const mounted = useRef(true)
  const activeAttempt = useRef<MobileFileMediaAttempt | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeAttempt.current?.cancel()
      activeAttempt.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      activeAttempt.current?.cancel()
      activeAttempt.current = null
    }
  }, [client, relativePath, worktreeId])

  const open = useCallback(async () => {
    if (!client || downloading) {
      return
    }
    setDownloading(true)
    setProgressBytes(0)
    setMessage('')
    const attempt = createMobileFileMediaAttempt()
    activeAttempt.current = attempt
    try {
      const sink = mediaHandoffSinkFor(worktreeId, relativePath)
      // Why: the download outlives the screen, so progress must not set state after unmount.
      await downloadMobileFileMedia(client, { worktreeId, relativePath }, sink, (bytes) => {
        if (mounted.current) {
          setProgressBytes(bytes)
        }
      }, attempt)
      // Why: navigating back mid-download must not raise the share sheet over the next screen.
      if (!mounted.current) {
        return
      }
      await Sharing.shareAsync(sink.uri, { mimeType, dialogTitle: `Open ${title}` })
    } catch (error) {
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : 'Unable to open file')
      }
    } finally {
      if (activeAttempt.current === attempt) {
        activeAttempt.current = null
      }
      if (mounted.current) {
        setDownloading(false)
      }
    }
  }, [client, downloading, mimeType, relativePath, title, worktreeId])

  if (!connected) {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>Waiting for desktop...</Text>
      </View>
    )
  }
  if (downloading) {
    return (
      <View style={styles.state}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={styles.stateText}>
          Downloading {formatPreviewByteLength(progressBytes)}...
        </Text>
      </View>
    )
  }
  return (
    <View style={styles.state}>
      {message ? <Text style={styles.errorText}>{message}</Text> : null}
      <Pressable
        style={({ pressed }) => [styles.retryButton, pressed && styles.backButtonPressed]}
        onPress={() => void open()}
        accessibilityRole="button"
        accessibilityLabel={`Open ${title} in another app`}
      >
        <ExternalLink size={16} color={colors.textPrimary} strokeWidth={2.2} />
        <Text style={styles.retryText}>Open</Text>
      </Pressable>
    </View>
  )
}
