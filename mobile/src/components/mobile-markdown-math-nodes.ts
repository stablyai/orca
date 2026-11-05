import type { Code, Parent, PhrasingContent, RootContent } from 'mdast'
import type MarkdownIt from 'markdown-it'
import { isDisplayMathOpener, markdownMathCloser } from '../../../src/shared/markdown-math-rules'

// The mdast nodes mobile-markdown-math's tokens become, shaped like desktop chat's math nodes.

type Token = ReturnType<MarkdownIt['parse']>[number]

/** Whether the formula's closing delimiter arrived; only a streaming block can lack one. */
function mathClosed(token: Token): boolean {
  const meta: unknown = token.meta
  return !(typeof meta === 'object' && meta !== null && 'closed' in meta && meta.closed === false)
}

/** A formula as authored, delimiters included. */
function mathSource(token: Token): string {
  const closer = mathClosed(token) ? markdownMathCloser(token.markup) : ''
  return `${token.markup}${token.content}${closer}`
}

export function inlineMathNode(token: Token): PhrasingContent {
  return {
    type: 'inlineMath',
    value: token.content.trim(),
    display: isDisplayMathOpener(token.markup),
    source: mathSource(token)
  }
}

export function mathBlockNode(token: Token): RootContent {
  return mathClosed(token)
    ? { type: 'math', value: token.content.trim(), source: mathSource(token) }
    : // An unclosed block is still streaming in; it stays as its source, as on desktop.
      { type: 'paragraph', children: [{ type: 'text', value: mathSource(token) }] }
}

/** Only an authored closing fence makes a math fence a formula. */
export function mathFenceNode(code: Code & { closed: boolean }): RootContent {
  return code.lang === 'math' && code.closed
    ? { type: 'math', value: code.value, source: code.value }
    : code
}

/** Link labels keep formulas as their source, as desktop does. */
export function withoutMath(nodes: PhrasingContent[]): PhrasingContent[] {
  return nodes.map((node) => {
    if (node.type === 'inlineMath') {
      return { type: 'text', value: node.source }
    }
    if ('children' in node) {
      node.children = withoutMath(node.children)
    }
    return node
  })
}

/** A paragraph of nothing but `$$`/`\[` formulas shows each as a display formula, as on desktop. */
export function displayFormulas(parent: Parent, paragraph: Parent): void {
  const formulas = paragraph.children.filter((child) => child.type === 'inlineMath')
  const alone = paragraph.children.every(
    (child) =>
      (child.type === 'inlineMath' && child.display) ||
      child.type === 'break' ||
      (child.type === 'text' && !child.value.trim())
  )
  if (formulas.length > 0 && alone && parent.children.at(-1) === paragraph) {
    parent.children.splice(
      -1,
      1,
      ...formulas.map((formula): RootContent => ({
        type: 'math',
        value: formula.value,
        source: formula.source
      }))
    )
  }
}

/** github.com draws `\Huge` at `\Large` (1.44em), so the PR line-count table's +/− glyphs sit
 *  inline at text height; the larger sizes are capped the same way here. */
export const GITHUB_MATH_SIZE_MACROS: Readonly<Record<string, string>> = {
  '\\LARGE': '\\Large',
  '\\huge': '\\Large',
  '\\Huge': '\\Large'
}

/** The enlarging size commands as drawn; smaller ones only leave a column a little wide. */
const TEX_SIZES: Record<string, number> = {
  large: 1.2,
  Large: 1.44,
  LARGE: 1.44,
  huge: 1.44,
  Huge: 1.44
}

/** About as many characters as a formula draws wide, for sizing table columns: commands,
 *  colour arguments, braces and scripts take no room, and a size command scales the rest. */
export function mobileMathMeasureText(value: string): string {
  const scale = Math.max(
    1,
    ...[...value.matchAll(/\\([a-zA-Z]+)/g)].map(([, name]) => TEX_SIZES[name!] ?? 1)
  )
  const glyphs = value
    .replace(/\\(?:color|textcolor)\{[^}]*\}/g, '')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}^_\s]/g, '')
  return 'm'.repeat(Math.ceil([...glyphs].length * scale))
}

declare module 'mdast' {
  interface InlineMath extends Literal {
    type: 'inlineMath'
    /** `$$` or `\[`: shown as a display formula when it stands alone in its paragraph. */
    display: boolean
    /** The authored text, delimiters included, for copying and fallbacks. */
    source: string
  }
  interface Math extends Literal {
    type: 'math'
    source: string
  }
  interface PhrasingContentMap {
    inlineMath: InlineMath
  }
  interface RootContentMap {
    inlineMath: InlineMath
    math: Math
  }
  interface BlockContentMap {
    math: Math
  }
}
