import type { Root } from 'mdast'
import { useMemo } from 'react'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat/native-chat-visual-directive'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'
import { protectMobileMarkdownVisualLines } from './mobile-markdown-visual-lines'

const NO_DIRECTIVES: NativeChatVisualDirective[] = []

/** The tree MobileMarkdown draws; with `visuals`, directive lines become placeholders. */
export function useMobileMarkdownTree(
  text: string,
  visuals: boolean,
  growing: boolean
): { root: Root; directives: NativeChatVisualDirective[] } {
  const visualLines = useMemo(
    () => (visuals ? protectMobileMarkdownVisualLines(text) : null),
    [text, visuals]
  )
  const source = visualLines?.text ?? text
  const root = useMemo(() => parseMobileMarkdownTree(source, growing), [source, growing])
  return { root, directives: visualLines?.directives ?? NO_DIRECTIVES }
}
