import { useState } from 'react'
import { View } from 'react-native'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { MobileSourceCopyButton } from '../components/MobileSourceCopyButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

export type MarkdownPreviewMode = 'preview' | 'source'

/** A line target opens the source; a new file or line target resets any manual pick. */
export function useMarkdownPreviewMode(relativePath: string, initialLine: number | undefined) {
  const [mode, setMode] = useState<MarkdownPreviewMode>(() => (initialLine ? 'source' : 'preview'))
  const [previousRelativePath, setPreviousRelativePath] = useState(relativePath)
  const [previousInitialLine, setPreviousInitialLine] = useState(initialLine)
  // Switch modes before paint for a new file or line target; do not flash the previous manual mode.
  if (relativePath !== previousRelativePath || initialLine !== previousInitialLine) {
    setPreviousRelativePath(relativePath)
    setPreviousInitialLine(initialLine)
    setMode(initialLine ? 'source' : 'preview')
  }
  return [mode, setMode] as const
}

type Props = {
  mode: MarkdownPreviewMode
  onModeChange: (mode: MarkdownPreviewMode) => void
  relativePath: string
  content: string
  truncated: boolean
}

export function MobileMarkdownPreviewModeBar({
  mode,
  onModeChange,
  relativePath,
  content,
  truncated
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.modeBar}>
      <MobileSegmentedControl
        segments={[
          {
            value: 'preview',
            label: t('files.fileMarkdownPreview.previewMode', 'Preview'),
            accessibilityLabel: t(
              'files.fileMarkdownPreview.viewPreview',
              'View rendered Markdown preview'
            )
          },
          {
            value: 'source',
            label: t('files.fileMarkdownPreview.sourceMode', 'Source'),
            accessibilityLabel: t('files.fileMarkdownPreview.viewSource', 'View Markdown source')
          }
        ]}
        selected={mode}
        onSelect={onModeChange}
        testIDPrefix="markdown-preview-mode-"
        style={styles.modeSwitch}
      />
      <MobileSourceCopyButton
        key={relativePath}
        text={content}
        partial={truncated}
        accessibilityLabel={
          truncated
            ? t('files.fileMarkdownPreview.copyLoadedSource', 'Copy loaded Markdown source')
            : t('files.fileMarkdownPreview.copySource', 'Copy Markdown source')
        }
      />
    </View>
  )
}
