import { INLINE_TEXT_SELECTION } from '../../platform/text-selection/inline-text-selection'
import { memo, useContext, useMemo, type ReactNode } from 'react'
import { Text as NativeText, View } from 'react-native'
import {
  markdownTonesSheet,
  scaledMarkdownText,
  stylesSheet,
  type MarkdownToneName
} from './mobile-markdown-styles'
import { renderBlocks, type MarkdownBlockContext } from './blocks/mobile-markdown-blocks'
import { MarkdownText } from './mobile-markdown-text'
import { MobileMarkdownRemoteImage } from './blocks/MobileMarkdownRemoteImage'
import { MarkdownTextContext, type MarkdownTextSetup } from './mobile-markdown-text-setup'
import { MarkdownLinkHandlerContext } from './links/markdown-link-handler'
import { useMobileMarkdownTree } from './parsing/use-mobile-markdown-tree'
import { MobileMarkdownSlackPeopleContext } from './parsing/mobile-markdown-mentions'
import {
  MobileMarkdownLinksContext,
  useNativeChatFileLinkExistsFrom
} from './links/mobile-markdown-links-context'
import type { NativeChatVisualDirective } from '../../../../src/shared/native-chat/visuals/native-chat-visual-directive'
import { useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'

type Props = {
  content?: string
  fallback?: string
  /** Makes paragraphs selectable; on native Android it instead turns block selection off. */
  rangeSelectable?: boolean
  /** Forward long presses from interactive Android transcript spans to the message. */
  onLongPress?: () => void
  /** Multiplier for every text size. Defaults to 1; the chat view passes >1 so its prose reads
   *  larger than the compact base. */
  textScale?: number
  /** Multiplies the prose's line heights; code keeps its own. */
  lineSpacing?: number
  /** The prose's face; code keeps mono. */
  fontFamily?: string
  // File targets call this with relative/absolute path and optional :line(:col); omit on screens without viewer to leave paths plain.
  onOpenFile?: (pathText: string) => void
  // Enable ::orca-visual directives only in assistant native-chat prose; keep callback identity stable for memoization.
  renderImage?: (href: string, alt: string, width?: number) => ReactNode
  renderVisual?: (directive: NativeChatVisualDirective, index: number) => ReactNode
  // Close incomplete streaming markup like desktop; diagrams remain code until text stops.
  growing?: boolean
  /** The text may end mid-path: chat file links show only answers already known. */
  streaming?: boolean
  /** Chat's math delimiters, `\(…\)` and `\[…\]` as well as `$`, as desktop chat reads them.
   *  GitHub text (PRs, Tasks, files) leaves them off, so `\[Bug\]` stays a bracket. */
  chatMath?: boolean
  /** The surface under the text: `userMessage` inside your own message's bubble. */
  tone?: MarkdownToneName
  /** The content is a Slack message's drawn form: its mention links draw as mentions. */
  slackMentions?: boolean
}

/** Without a surface's own image renderer, https images draw from the web (GitHub text). */
function renderRemoteImage(href: string, alt: string, width?: number): ReactNode {
  return /^https:\/\//i.test(href) ? (
    <MobileMarkdownRemoteImage uri={href} alt={alt} width={width} />
  ) : null
}

function MobileMarkdownContent({
  content,
  fallback = '',
  rangeSelectable = false,
  textScale = 1,
  lineSpacing = 1,
  fontFamily,
  onOpenFile,
  renderVisual,
  renderImage,
  growing = false,
  streaming = false,
  chatMath = false,
  tone: toneName = 'default',
  slackMentions = false
}: Props) {
  const styles = useThemedStyles(stylesSheet)
  const tones = useThemedStyles(markdownTonesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  // Interactive children own their touches and must forward the row action.
  const setup = useContext(MarkdownTextContext)
  const onOpenLink = useContext(MarkdownLinkHandlerContext)
  const links = useContext(MobileMarkdownLinksContext)
  const slackPeople = useContext(MobileMarkdownSlackPeopleContext)
  const fileLinkExists = useNativeChatFileLinkExistsFrom(
    links?.fileLinks ?? null,
    onOpenFile !== undefined,
    streaming
  )
  const text = content?.trim() ?? ''
  const { root, directives, cards } = useMobileMarkdownTree(
    text,
    renderVisual !== undefined,
    growing,
    chatMath,
    {
      fileLinkExists,
      githubRepo: links?.githubRepo,
      slackMentions,
      slackPeople
    }
  )
  if (!text) {
    return fallback ? (
      <MarkdownText selectable={rangeSelectable} style={styles.paragraph}>
        {fallback}
      </MarkdownText>
    ) : null
  }
  const tone = tones[toneName]
  const face = fontFamily ? { fontFamily } : null
  const ctx: MarkdownBlockContext = {
    growing,
    chatMath,
    onOpenFile,
    onOpenLink,
    filePathsLinkedInTree: fileLinkExists !== undefined,
    tone,
    styles,
    colors,
    t,
    textScale,
    lineSpacing,
    fontFamily,
    listText: [
      styles.listText,
      scaledMarkdownText(styles.listText, textScale, lineSpacing),
      face,
      tone.text
    ],
    listMarker: [
      styles.listMarker,
      scaledMarkdownText(styles.listMarker, textScale, lineSpacing),
      tone.secondary
    ],
    rowLongPress: setup.androidTranscript ? setup.onLongPress : undefined,
    directives,
    cards,
    renderVisual,
    renderImage: renderImage ?? renderRemoteImage,
    mermaidOccurrences: new Map()
  }
  // Native-chat range selection is set on each block; nested inline spans inherit it.
  return (
    <View style={styles.root}>
      {renderBlocks(root.children, ctx, {
        style: [
          styles.paragraph,
          scaledMarkdownText(styles.paragraph, textScale, lineSpacing),
          face,
          tone.text
        ],
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
    [androidTranscript, onLongPress]
  )
  return (
    <MarkdownTextContext.Provider value={setup}>
      <MobileMarkdownContent {...props} />
    </MarkdownTextContext.Provider>
  )
}

export const MobileMarkdown = memo(MobileMarkdownInner)
