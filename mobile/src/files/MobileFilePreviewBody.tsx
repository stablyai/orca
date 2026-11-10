import { MobileFileMediaPreview } from './MobileFileMediaPreview'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { Text, View } from 'react-native'
import { FileText } from 'lucide-react-native'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { MobileFilePreviewResult } from './mobile-file-preview-request'
import { MobileFileMarkdownPreview } from './MobileFileMarkdownPreview'
import type { MarkdownPreviewMode } from './MobileMarkdownPreviewModeBar'
import { MobileFilePreviewEditableSource } from './MobileFilePreviewEditableSource'
import { MobileFilePreviewSourceText } from './MobileFilePreviewSourceText'
import type { MobileFilePreviewLineColumn } from './mobile-file-preview-line-column'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { MobilePanZoomImage } from '../components/MobilePanZoomImage'
import { MobileHtmlPreview } from '../components/MobileHtmlPreview'
import { MobileSvgPreview } from '../components/MobileSvgPreview'
import {
  MobileLoadErrorState,
  MobileOfflineState,
  MobileStateView
} from '../components/MobileStateView'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

type Props = {
  preview: MobileFilePreviewResult
  client?: MobileFilePreviewRpcSender | null
  worktreeId?: string
  relativePath: string
  title: string
  editable: boolean
  /** Picked in the nav bar's Preview / Source switch. */
  markdownMode: MarkdownPreviewMode
  draftContent: string
  saveError: string
  lineColumn: MobileFilePreviewLineColumn | null
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
    return <MobileStateView loading title={preview.message} />
  }
  if (preview.status === 'waiting') {
    return <MobileOfflineState onReconnect={options.onRetry} />
  }
  if (preview.status === 'error') {
    return <MobileLoadErrorState error={preview.message} onRetry={options.onRetry} />
  }
  if (preview.status === 'empty') {
    return options.editable ? (
      <EditablePreviewSource {...options} />
    ) : (
      <MobileStateView icon={FileText} title={t('files.filePreviewBody.emptyFile', 'Empty file')} />
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
        <MobilePanZoomImage
          uri={preview.dataUri}
          onError={options.onImageError}
          label={t('files.filePreviewBody.imageLabel', '{{title}} image', {
            title: options.title
          })}
        />
      </View>
    )
  }
  if (preview.kind === 'markdown') {
    return options.editable ? (
      <EditablePreviewSource {...options} />
    ) : (
      <MobileFileMarkdownPreview
        mode={options.markdownMode}
        relativePath={options.relativePath}
        client={options.client}
        worktreeId={options.worktreeId}
        content={preview.content}
        truncated={preview.truncated}
        byteLength={preview.byteLength}
        initialLine={options.lineColumn?.line}
        onOpenFile={options.onOpenFile}
      />
    )
  }
  if ((preview.kind === 'svg' || preview.kind === 'html') && !preview.truncated) {
    const content = options.editable ? options.draftContent : preview.content
    const notice =
      options.editable && options.saveError ? (
        <Text style={styles.previewSaveErrorText}>{options.saveError}</Text>
      ) : null
    const renderSource = () =>
      options.editable ? (
        <EditablePreviewSource {...options} />
      ) : (
        <MobileFilePreviewSourceText
          relativePath={options.relativePath}
          content={preview.content}
          truncated={false}
          byteLength={preview.byteLength}
          initialLine={options.lineColumn?.line}
        />
      )

    return preview.kind === 'svg' ? (
      <MobileSvgPreview
        markup={content}
        title={options.title}
        notice={notice}
        renderSource={renderSource}
      />
    ) : (
      <MobileHtmlPreview
        html={content}
        initialMode={options.lineColumn?.line ? 'source' : 'preview'}
        notice={notice}
        renderSource={renderSource}
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
