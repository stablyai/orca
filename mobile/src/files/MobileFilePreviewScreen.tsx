import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { getWorktreeLabel } from '../session/worktree-label'
import { colors, spacing } from '../theme/mobile-theme'
import { useForceReconnect, useHostClient } from '../transport/client-context'
import {
  loadMobileFilePreview,
  previewError,
  type MobileFilePreviewResult
} from './mobile-file-preview-request'
import { MobileFileMarkdownPreview } from './MobileFileMarkdownPreview'
import { MobileFilePreviewSourceText } from './MobileFilePreviewSourceText'
import {
  displayNameFromPreviewPath,
  type MobileFilePreviewRouteState
} from './mobile-file-preview-route'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

type Props = {
  route: MobileFilePreviewRouteState
}

export function MobileFilePreviewScreen({ route }: Props) {
  const router = useRouter()
  const previewParams = route.ok ? route.params : null
  const { client, state: connState } = useHostClient(previewParams?.hostId)
  const forceReconnect = useForceReconnect()
  const [preview, setPreview] = useState<MobileFilePreviewResult>(() =>
    route.ok ? { status: 'loading', message: 'Loading preview...' } : previewError(route.message)
  )
  const { width, height } = useWindowDimensions()

  const loadPreview = useCallback(async () => {
    if (!previewParams) {
      setPreview(previewError(route.ok ? 'Unable to load preview' : route.message))
      return
    }
    if (!client || connState !== 'connected') {
      setPreview({ status: 'waiting', message: 'Waiting for desktop...', reconnect: true })
      return
    }
    setPreview({ status: 'loading', message: 'Loading preview...' })
    try {
      const result = await loadMobileFilePreview(
        client,
        previewParams.worktreeId,
        previewParams.relativePath
      )
      setPreview(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load preview'
      setPreview(previewError(message))
    }
  }, [client, connState, previewParams, route])

  useEffect(() => {
    void loadPreview()
  }, [loadPreview])

  const retry = useCallback(async () => {
    if (!previewParams) {
      void loadPreview()
      return
    }
    if (
      preview.status === 'waiting' ||
      (preview.status === 'error' && preview.reconnect) ||
      connState !== 'connected'
    ) {
      await forceReconnect(previewParams.hostId)
      return
    }
    void loadPreview()
  }, [connState, forceReconnect, loadPreview, preview, previewParams])

  const title = previewParams?.name ?? displayNameFromPreviewPath(previewParams?.relativePath ?? '')
  const worktreeLabel = getWorktreeLabel(
    previewParams?.worktreeName,
    previewParams?.worktreeId ?? ''
  )
  const meta = previewParams ? `${worktreeLabel} - ${previewParams.relativePath}` : 'Preview'

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.header} edges={['top']}>
        <View style={styles.topBar}>
          <Pressable
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityLabel="Back to files"
          >
            <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
          <View style={styles.titleBlock}>
            <Text style={styles.title} numberOfLines={1}>
              {title || 'Preview'}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
          </View>
        </View>
      </SafeAreaView>
      {renderPreviewBody(preview, {
        relativePath: previewParams?.relativePath ?? '',
        title: title || 'File',
        imageWidth: Math.max(1, width - spacing.md * 2),
        imageHeight: Math.max(240, height - 160),
        onImageError: () =>
          setPreview({ status: 'error', message: 'Unable to load preview', reconnect: false }),
        onRetry: retry
      })}
    </View>
  )
}

function renderPreviewBody(
  preview: MobileFilePreviewResult,
  options: {
    relativePath: string
    title: string
    imageWidth: number
    imageHeight: number
    onImageError: () => void
    onRetry: () => void
  }
) {
  if (preview.status === 'loading') {
    return (
      <View style={styles.state}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={styles.stateText}>{preview.message}</Text>
      </View>
    )
  }

  if (preview.status === 'error' || preview.status === 'waiting') {
    return (
      <View style={styles.state}>
        <Text style={styles.errorText}>{preview.message}</Text>
        <Pressable style={styles.retryButton} onPress={options.onRetry}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    )
  }

  if (preview.status === 'empty') {
    return (
      <View style={styles.state}>
        <Text style={styles.stateText}>Empty file</Text>
      </View>
    )
  }

  if (preview.kind === 'image') {
    return (
      <View style={styles.imageContainer}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.imageScrollContent}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
        >
          <Image
            source={{ uri: preview.dataUri }}
            style={[styles.image, { width: options.imageWidth, height: options.imageHeight }]}
            resizeMode="contain"
            onError={options.onImageError}
            accessibilityLabel={`${options.title} image`}
          />
        </ScrollView>
      </View>
    )
  }

  if (preview.kind === 'markdown') {
    return (
      <MobileFileMarkdownPreview
        relativePath={options.relativePath}
        content={preview.content}
        truncated={preview.truncated}
        byteLength={preview.byteLength}
      />
    )
  }

  if (preview.kind === 'html') {
    return (
      <MobileFilePreviewSourceText
        relativePath={options.relativePath}
        content={preview.content}
        truncated={preview.truncated}
        byteLength={preview.byteLength}
      />
    )
  }

  return (
    <MobileFilePreviewSourceText
      relativePath={options.relativePath}
      content={preview.content}
      truncated={preview.truncated}
      byteLength={preview.byteLength}
    />
  )
}
