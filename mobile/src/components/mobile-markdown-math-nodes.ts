import type { Code, Parent, PhrasingContent, RootContent } from 'mdast'
import { isDisplayMathOpener, markdownMathCloser } from '../../../src/shared/markdown-math-rules'
import type { Token } from './mobile-markdown-code-nodes'

// The mdast nodes mobile-markdown-math's tokens become, shaped like desktop chat's math nodes.

/** Whether the formula's closing delimiter arrived; only a streaming block can lack one. */
export function mathClosed(token: Token): boolean {
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
const TEX_SIZES: Record<string, number> = { large: 1.2, Large: 1.44 }

const MAX_MEASURED_GLYPHS = 64
const DRAWS_NOTHING =
  /^(?:math[a-z]+|text[a-z]*|operatorname|boldsymbol|bm|left|right|[a-z]*style|tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge|color|frac|dfrac|tfrac|sqrt)$/

/** About as many characters as a formula draws wide, for sizing table columns: commands,
 *  colour arguments, braces and scripts take no room, and a size command scales the rest. */
export function mobileMathMeasureText(value: string): string {
  let scale = 1
  for (const [, name] of value.matchAll(/\\([a-zA-Z]+)/g)) {
    const drawn = GITHUB_MATH_SIZE_MACROS[`\\${name!}`]?.slice(1) ?? name!
    scale = Math.max(scale, TEX_SIZES[drawn] ?? 1)
  }
  const glyphs = value
    .replace(/\\(?:color|textcolor)\{[^}]*\}/g, '')
    // A symbol command (\alpha, \sum) draws one glyph; style and size commands draw none.
    .replace(/\\([a-zA-Z]+)/g, (_command, name: string) => (DRAWS_NOTHING.test(name) ? '' : 'x'))
    .replace(/[{}^_\s]/g, '')
  // Columns cap well below this, so a huge formula needs no longer estimate.
  return 'm'.repeat(Math.min(MAX_MEASURED_GLYPHS, Math.ceil([...glyphs].length * scale)))
}
