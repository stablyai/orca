import {
  NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER,
  NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE,
  parseNativeChatVisualDirectiveLine,
  type NativeChatVisualDirective
} from '../../../src/shared/native-chat/native-chat-visual-directive'
import { mobileMarkdownCodeLines } from './mobile-markdown-tree'
// Private-use delimiters, as the preview normalizer's own code placeholders use.
const PLACEHOLDER_PREFIX = '\uE000ORCA_VISUAL_'
const PLACEHOLDER = /^\uE000ORCA_VISUAL_(\d+)\uE000$/

export type MobileMarkdownVisualLines = {
  /** The content with each recognized directive line replaced by a placeholder line. */
  text: string
  directives: NativeChatVisualDirective[]
}

function placeholderFor(index: number): string {
  return `${PLACEHOLDER_PREFIX}${index}\uE000`
}

// Extract assistant visual directives before parser decodes entities/tags and rewrites titles; only non-code top-level marker lines count. Past cap, keep literal text.
export function protectMobileMarkdownVisualLines(content: string): MobileMarkdownVisualLines {
  // Text that already spells a placeholder would alias a real one; it renders no visuals at all.
  if (
    content.includes(PLACEHOLDER_PREFIX) ||
    !content.includes(NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER)
  ) {
    return { text: content, directives: [] }
  }
  const normalized = content.replace(/\r\n?/g, '\n')
  const code = mobileMarkdownCodeLines(normalized)
  const directives: NativeChatVisualDirective[] = []
  const next = normalized.split('\n').map((line, index) => {
    if (code.has(index) || directives.length >= NATIVE_CHAT_VISUAL_MAX_PER_MESSAGE) {
      return line
    }
    const directive = parseNativeChatVisualDirectiveLine(line)
    if (!directive) {
      return line
    }
    directives.push(directive)
    // Blank lines around it make the directive its own block, splitting any paragraph it was in.
    return `\n${placeholderFor(directives.length - 1)}\n`
  })
  return { text: next.join('\n'), directives }
}

/** The directive index a parsed line stands for, or null for any other line. */
export function mobileMarkdownVisualPlaceholderIndex(line: string, count: number): number | null {
  const match = PLACEHOLDER.exec(line.trim())
  if (!match) {
    return null
  }
  const index = Number(match[1])
  return index < count ? index : null
}
