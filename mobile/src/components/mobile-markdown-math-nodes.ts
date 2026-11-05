import type { Code, Paragraph, Parent, PhrasingContent, RootContent } from 'mdast'
import type MarkdownIt from 'markdown-it'
import { isDisplayMathOpener, markdownMathCloser } from '../../../src/shared/markdown-math-rules'
import type { MobileMarkdownMathMeta } from './mobile-markdown-math'

// The mdast nodes mobile-markdown-math's tokens become, shaped like desktop chat's math nodes.

type Token = ReturnType<MarkdownIt['parse']>[number]

/** A formula as authored, delimiters included. */
function mathSource(token: Token): string {
  const { opener, closed } = token.meta as MobileMarkdownMathMeta
  return `${opener}${token.content}${closed ? markdownMathCloser(opener) : ''}`
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
  return (token.meta as MobileMarkdownMathMeta).closed
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
  return nodes.map((node) =>
    node.type === 'inlineMath'
      ? { type: 'text', value: node.source }
      : 'children' in node
        ? ({ ...node, children: withoutMath(node.children) } as PhrasingContent)
        : node
  )
}

/** A paragraph of nothing but `$$`/`\[` formulas shows each as a display formula, as on desktop. */
export function displayFormulas(parent: Parent, paragraph: Paragraph): void {
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

/** KaTeX's enlarging size commands; smaller ones only leave a column a little wide. */
const TEX_SIZES: Record<string, number> = {
  large: 1.2,
  Large: 1.44,
  LARGE: 1.73,
  huge: 2.07,
  Huge: 2.49
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
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface InlineMath extends Literal {
    type: 'inlineMath'
    /** `$$` or `\[`: shown as a display formula when it stands alone in its paragraph. */
    display: boolean
    /** The authored text, delimiters included, for copying and fallbacks. */
    source: string
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface Math extends Literal {
    type: 'math'
    source: string
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface PhrasingContentMap {
    inlineMath: InlineMath
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface RootContentMap {
    inlineMath: InlineMath
    math: Math
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Declaration merging registers the node.
  interface BlockContentMap {
    math: Math
  }
}
