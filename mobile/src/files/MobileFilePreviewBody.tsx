import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import type { MobileFilePreviewResult } from './mobile-file-preview-request'
import { MobileFileMarkdownPreview } from './MobileFileMarkdownPreview'
import { MobileFilePreviewEditableSource } from './MobileFilePreviewEditableSource'
import { MobileFilePreviewSourceText } from './MobileFilePreviewSourceText'
import type { MobileFilePreviewLineColumn } from './mobile-file-preview-line-column'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

type Props = {
  preview: MobileFilePreviewResult
  relativePath: string
  title: string
  editable: boolean
  draftContent: string
  saveError: string
  lineColumn: MobileFilePreviewLineColumn | null
  imageWidth: number
  imageHeight: number
  onDraftChange: (content: string) => void
  onImageError: () => void
  onRetry: () => void
}

export function MobileFilePreviewBody({ preview, ...options }: Props) {
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
    return options.editable ? (
      <EditablePreviewSource {...options} />
    ) : (
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
    return options.editable ? (
      <EditablePreviewSource {...options} />
    ) : (
      <MobileFileMarkdownPreview
        relativePath={options.relativePath}
        content={preview.content}
        truncated={preview.truncated}
        byteLength={preview.byteLength}
        initialLine={options.lineColumn?.line}
      />
    )
  }
  if (preview.kind === 'html') {
    return options.editable ? (
      <EditablePreviewSource {...options} />
    ) : (
      <MobileFilePreviewSourceText
        relativePath={options.relativePath}
        content={preview.content}
        truncated={preview.truncated}
        byteLength={preview.byteLength}
        initialLine={options.lineColumn?.line}
      />
    )
  }
  if (options.editable) {
    return <EditablePreviewSource {...options} />
  }
  return (
    <MobileFilePreviewSourceText
      relativePath={options.relativePath}
      content={preview.content}
      truncated={preview.truncated}
      byteLength={preview.byteLength}
      initialLine={options.lineColumn?.line}
    />
  )
}

function EditablePreviewSource(options: {
  title: string
  draftContent: string
  saveError: string
  lineColumn: MobileFilePreviewLineColumn | null
  onDraftChange: (content: string) => void
}) {
  return (
    <MobileFilePreviewEditableSource
      title={options.title}
      draftContent={options.draftContent}
      saveError={options.saveError}
      lineColumn={options.lineColumn}
      onDraftChange={options.onDraftChange}
    />
  )
}
