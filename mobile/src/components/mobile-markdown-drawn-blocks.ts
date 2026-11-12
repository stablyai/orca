import type { RootContent } from 'mdast'
import type { ReactNode } from 'react'
import { getMobileUiRevision } from '../i18n/mobile-i18n'
import { getMobileColorScheme } from '../theme/mobile-theme'
import type { MarkdownBlockContext, ParagraphText } from './mobile-markdown-blocks'

type DrawnBlock = {
  /** Blocks read themed styles and copy straight from the scheme and language. */
  look: string
  ctx: MarkdownBlockContext
  text: ParagraphText
  element: ReactNode
}

/** Top-level blocks drawn while the text grows. A finished block keeps its node across parses,
 *  so it keeps its element too, and React skips its subtree. */
const drawnBlocks = new WeakMap<RootContent, DrawnBlock>()

function isStyleObject(style: unknown): style is Record<string, unknown> {
  return typeof style === 'object' && style !== null && !Array.isArray(style)
}

/** Callers build their style arrays on every render, so styles compare by value. */
function sameStyle(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((style, index) => sameStyle(style, b[index]))
  }
  if (!isStyleObject(a) || !isStyleObject(b)) {
    return false
  }
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/** `mermaidOccurrences` is left out: diagrams draw only once the text stops growing. */
function sameContext(a: MarkdownBlockContext, b: MarkdownBlockContext): boolean {
  return (
    a.growing === b.growing &&
    a.chatMath === b.chatMath &&
    a.textScale === b.textScale &&
    a.tone === b.tone &&
    a.onOpenFile === b.onOpenFile &&
    a.onOpenLink === b.onOpenLink &&
    a.filePathsLinkedInTree === b.filePathsLinkedInTree &&
    a.rowLongPress === b.rowLongPress &&
    a.renderImage === b.renderImage &&
    a.renderVisual === b.renderVisual &&
    sameStyle(a.listText, b.listText) &&
    sameStyle(a.listMarker, b.listMarker) &&
    a.directives.length === b.directives.length &&
    a.directives.every(
      (directive, index) =>
        directive.file === b.directives[index]?.file &&
        directive.title === b.directives[index]?.title
    )
  )
}

/** While the text grows, the block's element from the last render when nothing it draws with
 *  changed; otherwise `render()`. Once the text stops, its drawings are let go. */
export function drawnBlock(
  node: RootContent,
  ctx: MarkdownBlockContext,
  text: ParagraphText,
  render: () => ReactNode
): ReactNode {
  if (!ctx.growing) {
    drawnBlocks.delete(node)
    return render()
  }
  const drawn = drawnBlocks.get(node)
  const look = `${getMobileColorScheme()}:${getMobileUiRevision()}`
  if (
    drawn?.look === look &&
    drawn.text.selectable === text.selectable &&
    sameStyle(drawn.text.style, text.style) &&
    sameContext(drawn.ctx, ctx)
  ) {
    return drawn.element
  }
  const element = render()
  drawnBlocks.set(node, { look, ctx, text, element })
  return element
}
