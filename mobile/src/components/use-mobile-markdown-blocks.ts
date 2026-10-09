import { useMemo } from 'react'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat-visual-directive'
import { normalizeMobileMarkdownPreviewHtml } from './mobile-markdown-preview-html'
import { parseMobileMarkdown, type MobileMarkdownBlock } from './mobile-markdown-parser'
import { protectMobileMarkdownVisualLines } from './mobile-markdown-visual-lines'

const NO_DIRECTIVES: NativeChatVisualDirective[] = []

/** The blocks MobileMarkdown draws; with `visuals`, directive lines become `visual` blocks. */
export function useMobileMarkdownBlocks(
  text: string,
  visuals: boolean
): { blocks: MobileMarkdownBlock[]; directives: NativeChatVisualDirective[] } {
  const visualLines = useMemo(
    () => (visuals ? protectMobileMarkdownVisualLines(text) : null),
    [text, visuals]
  )
  const previewText = useMemo(
    () => normalizeMobileMarkdownPreviewHtml(visualLines?.text ?? text),
    [visualLines, text]
  )
  const directives = visualLines?.directives ?? NO_DIRECTIVES
  const blocks = useMemo(
    () => parseMobileMarkdown(previewText, directives.length),
    [previewText, directives.length]
  )
  return { blocks, directives }
}
