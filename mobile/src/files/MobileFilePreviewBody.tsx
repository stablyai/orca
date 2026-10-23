import { MobileFileMediaPreview } from './MobileFileMediaPreview'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { Image, ScrollView, View } from 'react-native'
import { FileX, WifiOff } from 'lucide-react-native'
import type { MobileFilePreviewResult } from './mobile-file-preview-request'
import { MobileFileMarkdownPreview } from './MobileFileMarkdownPreview'
import { MobileFilePreviewEditableSource } from './MobileFilePreviewEditableSource'
import { MobileFilePreviewSourceText } from './MobileFilePreviewSourceText'
import type { MobileFilePreviewLineColumn } from './mobile-file-preview-line-column'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { MobileLoadErrorState } from '../components/MobileLoadErrorState'
import { MobileHtmlPreview } from '../components/MobileHtmlPreview'
import { MobilePreviewModeToolbar } from '../components/MobilePreviewModeToolbar'
import { MobileSourceCopyButton } from '../components/MobileSourceCopyButton'
import { StateView } from '../components/ui/StateView'

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
  imageWidth: number
  imageHeight: number
  onDraftChange: (content: string) => void
  onImageError: () => void
  onOpenFile?: (pathText: string) => void
  /** Null where the only retry is a re-dial this document cannot make. */
  onRetry: (() => void) | null
}

export function MobileFilePreviewBody({ preview, ...options }: Props) {
  if (preview.status === 'loading') {
    return <StateView loading title={preview.message} />
  }
  if (preview.status === 'waiting') {
    return (
      <StateView
        icon={WifiOff}
        title="Waiting for desktop"
        message="The file opens once your desktop is back online."
        primary={options.onRetry ? { label: 'Retry', onPress: options.onRetry } : undefined}
      />
    )
  }
  if (preview.status === 'error') {
    return <MobileLoadErrorState message={preview.message} onRetry={options.onRetry} />
  }
  if (preview.status === 'empty') {
    return options.editable ? (
      <EditablePreviewSource {...options} />
    ) : (
      <StateView icon={FileX} title="Empty file" message="This file has no contents." />
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
  if (options.editable) {
    return <EditablePreviewSource {...options} />
  }
  const source = (
    <MobileFilePreviewSourceText
      relativePath={options.relativePath}
      content={preview.content}
      truncated={preview.truncated}
      byteLength={preview.byteLength}
      initialLine={options.lineColumn?.line}
    />
  )
  const copy = (
    <MobileSourceCopyButton
      key={options.relativePath}
      text={preview.content}
      partial={preview.truncated}
      accessibilityLabel={preview.truncated ? 'Copy loaded source' : 'Copy source'}
    />
  )
  if (preview.kind === 'html') {
    return (
      <View style={styles.modeContainer}>
        <MobileHtmlPreview html={preview.content} renderSource={() => source} trailing={copy} />
      </View>
    )
  }
  return (
    <View style={styles.modeContainer}>
      <MobilePreviewModeToolbar caption={lineCountLabel(preview.content)} trailing={copy} />
      {source}
    </View>
  )
}

function lineCountLabel(content: string): string {
  let lines = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lines += 1
    }
  }
  if (content.endsWith('\n')) {
    lines -= 1
  }
  return lines === 1 ? '1 line' : `${lines.toLocaleString()} lines`
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
