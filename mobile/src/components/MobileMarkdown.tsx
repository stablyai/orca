import { INLINE_TEXT_SELECTION } from './inline-text-selection'
import { memo, useContext, useMemo, type ReactNode } from 'react'
import { Text as NativeText, View } from 'react-native'
import { MARKDOWN_TONES, scaledMarkdownText, styles } from './mobile-markdown-styles'
import { renderBlocks, type MarkdownBlockContext } from './mobile-markdown-blocks'
import { MarkdownText } from './mobile-markdown-text'
import { MarkdownTextContext, type MarkdownTextSetup } from './mobile-markdown-text-setup'
import { useMobileMarkdownTree } from './use-mobile-markdown-tree'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat-visual-directive'

type Props = {
  content?: string
  fallback?: string
  /** Enables iOS range selection for native-chat transcript prose. */
  rangeSelectable?: boolean
  /** Forward long presses from interactive Android transcript spans to the message. */
  onLongPress?: () => void
  /** Multiplier for every text size. Defaults to 1; the chat view passes >1 so its prose reads
   *  larger than the compact base. */
  textScale?: number
  // File targets call this with relative/absolute path and optional :line(:col); omit on screens without viewer to leave paths plain.
  onOpenFile?: (pathText: string) => void
  // Enable ::orca-visual directives only in assistant native-chat prose; keep callback identity stable for memoization.
  renderImage?: (href: string, alt: string) => ReactNode
  renderVisual?: (directive: NativeChatVisualDirective, index: number) => ReactNode
  // Close incomplete streaming markup like desktop; diagrams remain code until text stops.
  growing?: boolean
  /** The surface under the text: `onBright` for your own message's light fill. */
  tone?: keyof typeof MARKDOWN_TONES
}

function MobileMarkdownContent({
  content,
  fallback = '',
  rangeSelectable = false,
  textScale = 1,
  onOpenFile,
  renderVisual,
  renderImage,
  growing = false,
  tone: toneName = 'default'
}: Props) {
  // Interactive children own their touches and must forward the row action.
  const setup = useContext(MarkdownTextContext)
  const text = content?.trim() ?? ''
  const { root, directives } = useMobileMarkdownTree(text, renderVisual !== undefined, growing)
  if (!text) {
    return fallback ? (
      <MarkdownText selectable={rangeSelectable} style={styles.paragraph}>
        {fallback}
      </MarkdownText>
    ) : null
  }
  const tone = MARKDOWN_TONES[toneName]
  const ctx: MarkdownBlockContext = {
    growing,
    onOpenFile,
    tone,
    textScale,
    // Zoomed list text has read a size above the sheet's since it first scaled; kept as it was.
    listText: [
      styles.listText,
      scaledMarkdownText({ fontSize: 14, lineHeight: 20 }, textScale),
      tone.text
    ],
    rowLongPress: setup.androidTranscript ? setup.onLongPress : undefined,
    directives,
    renderVisual,
    renderImage,
    mermaidOccurrences: new Map()
  }
  // Native-chat range selection is set on each block; nested inline spans inherit it.
  return (
    <View style={styles.root}>
      {renderBlocks(root.children, ctx, {
        style: [styles.paragraph, scaledMarkdownText(styles.paragraph, textScale), tone.text],
        selectable: rangeSelectable
      })}
    </View>
  )
}

function MobileMarkdownInner(props: Props): React.JSX.Element | null {
  const { rangeSelectable = false, onLongPress } = props
  // Other Markdown surfaces retain their existing selection behavior.
  const androidTranscript = rangeSelectable && !INLINE_TEXT_SELECTION
  const setup = useMemo<MarkdownTextSetup>(
    () => ({
      TextComponent: NativeText,
      androidTranscript,
      ...(onLongPress ? { onLongPress } : {})
    }),
    [rangeSelectable, androidTranscript, onLongPress]
  )
  return (
    <MarkdownTextContext.Provider value={setup}>
      <MobileMarkdownContent {...props} />
    </MarkdownTextContext.Provider>
  )
}

export const MobileMarkdown = memo(MobileMarkdownInner)
