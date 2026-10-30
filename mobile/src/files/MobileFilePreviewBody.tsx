import { MobileFileMediaPreview } from './MobileFileMediaPreview'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { ActivityIndicator, Image, ScrollView, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { MobileFilePreviewResult } from './mobile-file-preview-request'
import { MobileFileMarkdownPreview } from './MobileFileMarkdownPreview'
import { MobileFilePreviewEditableSource } from './MobileFilePreviewEditableSource'
import { MobileFilePreviewSourceText } from './MobileFilePreviewSourceText'
import { MobileFileAddressToolbar } from '../components/MobileFileAddressToolbar'
import type { MobileFilePreviewLineColumn } from './mobile-file-preview-line-column'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

type Props = {
  preview: MobileFilePreviewResult
  client?: MobileFilePreviewRpcSender | null
  worktreeId?: string
  relativePath: string
  title: string
  editable: boolean
  draftContent: string
  saveError: string
  lineColumn: MobileFilePreviewLineColumn | null
  initialLineSeq?: number
  imageWidth: number
  imageHeight: number
  showLineNumbers?: boolean
  onToggleLineNumbers?: () => void
  onDraftChange: (content: string) => void
  onImageError: () => void
  onOpenFile?: (pathText: string) => void
  /** Null where the only retry is a re-dial this document cannot make. */
  onRetry: (() => void) | null
}

export function MobileFilePreviewBody({ preview, ...options }: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (preview.status === 'loading') {
    return (
      <View style={styles.state}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={styles.stateText}>{preview.message}</Text>
      </View>
    )
  }
  if (preview.status === 'error' || preview.status === 'waiting') {
    return <MobileLoadErrorState message={preview.message} onRetry={options.onRetry} />
  }
  if (preview.status === 'empty') {
    return options.editable ? (
      <EditablePreviewSource {...options} />
    ) : (
      <View style={styles.codeContainer}>
        <MobileFileAddressToolbar
          path={options.relativePath || options.title}
          showLineNumbers={options.showLineNumbers}
          onToggleLineNumbers={options.onToggleLineNumbers}
          content=""
          truncated={false}
          copyAccessibilityLabel={t('files.filePreviewBody.copyContent', 'Copy file content')}
        />
        <View style={styles.state}>
          <Text style={styles.stateText}>{t('files.filePreviewBody.emptyFile', 'Empty file')}</Text>
        </View>
      </View>
    )
  }
  if (preview.kind === 'media') {
    return (
      <MobileFileMediaPreview
        media={preview.media}
        client={options.client ?? null}
        title={options.title}
      />
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
            accessibilityLabel={t('files.filePreviewBody.imageLabel', '{{title}} image', {
              title: options.title
            })}
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
        client={options.client}
        worktreeId={options.worktreeId}
        content={preview.content}
        truncated={preview.truncated}
        byteLength={preview.byteLength}
        initialLine={options.lineColumn?.line}
        initialLineSeq={options.initialLineSeq}
        showLineNumbers={options.showLineNumbers}
        onToggleLineNumbers={options.onToggleLineNumbers}
        onOpenFile={options.onOpenFile}
      />
    )
  }
  if (preview.kind === 'html') {
    return options.editable ? (
      <EditablePreviewSource {...options} />
    ) : (
      <View style={styles.codeContainer}>
        <MobileFileAddressToolbar
          path={options.relativePath || options.title}
          showLineNumbers={options.showLineNumbers}
          onToggleLineNumbers={options.onToggleLineNumbers}
          content={preview.content}
          truncated={preview.truncated}
          copyAccessibilityLabel="Copy file content"
        />
        <MobileFilePreviewSourceText
          relativePath={options.relativePath}
          content={preview.content}
          truncated={preview.truncated}
          byteLength={preview.byteLength}
          initialLine={options.lineColumn?.line}
          initialLineSeq={options.initialLineSeq}
          showLineNumbers={options.showLineNumbers}
        />
      </View>
    )
  }
  if (options.editable) {
    return <EditablePreviewSource {...options} />
  }
  return (
    <View style={styles.codeContainer}>
      <MobileFileAddressToolbar
        path={options.relativePath || options.title}
        showLineNumbers={options.showLineNumbers}
        onToggleLineNumbers={options.onToggleLineNumbers}
        content={preview.content}
        truncated={preview.truncated}
        copyAccessibilityLabel="Copy file content"
      />
      <MobileFilePreviewSourceText
        relativePath={options.relativePath}
        content={preview.content}
        truncated={preview.truncated}
        byteLength={preview.byteLength}
        initialLine={options.lineColumn?.line}
        initialLineSeq={options.initialLineSeq}
        showLineNumbers={options.showLineNumbers}
      />
    </View>
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
