import type {
  BlockContent,
  DefinitionContent,
  Details,
  Parent,
  PhrasingContent,
  RootContent
} from 'mdast'

// GitHub's `<details>` sections, which desktop draws as native disclosure widgets.

type DetailsPiece =
  | { kind: 'html'; value: string }
  | { kind: 'open'; open: boolean }
  | { kind: 'summary'; value: string }
  | { kind: 'close' }

// Comments match first so markup inside them stays text. Each scan stops at the next tag or
// summary, and an unclosed comment runs to the end once, so hostile input stays linear.
const DETAILS_MARKUP =
  /<!--(?:(?!-->)[\s\S])*(?:-->|$)|<details(?=[\s/>])([^<>]*)>|<summary(?=[\s/>])[^<>]*>((?:(?!<\/?summary\b)[\s\S])*)<\/summary\s*>|<\/details\s*>/gi
/** Deeper sections stay text, so hostile nesting cannot exhaust the tree walk's stack. */
const MAX_SECTION_DEPTH = 8
/** Sections whose `</details>` came inside a list or quote; each closes when that container does. */
const closedInside = new WeakSet<Parent>()

/** One HTML block cut around its `<details>` markup, or null when it has none. */
function detailsPieces(html: string): DetailsPiece[] | null {
  const pieces: DetailsPiece[] = []
  let from = 0
  for (const match of html.matchAll(DETAILS_MARKUP)) {
    const [markup, attributes, summary] = match
    if (markup.startsWith('<!--')) {
      continue
    }
    const text = html.slice(from, match.index)
    if (text.trim()) {
      pieces.push({ kind: 'html', value: text })
    }
    if (summary !== undefined) {
      pieces.push({ kind: 'summary', value: summary })
    } else if (markup.startsWith('</')) {
      pieces.push({ kind: 'close' })
    } else {
      // `open` is a boolean attribute; quoted values such as title="open logs" are not it.
      const names = (attributes ?? '').replace(/"[^"]*"|'[^']*'/g, '')
      pieces.push({ kind: 'open', open: /(?:^|\s)open(?:\s|=|$)/i.test(names) })
    }
    from = match.index + markup.length
  }
  if (pieces.length === 0) {
    return null
  }
  const rest = html.slice(from)
  if (rest.trim()) {
    pieces.push({ kind: 'html', value: rest })
  }
  return pieces
}

function isDetails(node: Parent | undefined): node is Details {
  return node?.type === 'details'
}

/** Closes the container on top, with any section left open inside it and any section whose
 *  `</details>` arrived inside it. */
export function popContainer(stack: Parent[]): Parent | undefined {
  while (isDetails(stack.at(-1))) {
    stack.pop()
  }
  const closed = stack.pop()
  while (isDetails(stack.at(-1)) && closedInside.has(stack.at(-1)!)) {
    stack.pop()
  }
  return closed
}

/** Like a browser, `</details>` inside a paragraph or list item ends the innermost section when
 *  that container ends. */
function closeSectionWithContainer(stack: Parent[]): void {
  const section = stack.findLast(isDetails)
  if (section) {
    closedInside.add(section)
  }
}

/** Inline HTML in a paragraph: a `</details>` there closes the section with the paragraph. */
export function noteInlineHtml(html: string, stack: Parent[]): void {
  if (/^<\/details\s*>$/i.test(html)) {
    closeSectionWithContainer(stack)
  }
}

/** Appends an HTML block to the open parent; its `<details>` markup opens and closes sections. */
export function appendHtmlBlock(
  html: string,
  stack: Parent[],
  open: (node: Parent & RootContent) => void,
  summaryPhrasing: (html: string) => PhrasingContent[]
): void {
  for (const piece of detailsPieces(html) ?? [{ kind: 'html', value: html }]) {
    const current = stack.at(-1)!
    const details = isDetails(current) ? current : null
    const sections = stack.filter(isDetails)
    if (piece.kind === 'open') {
      if (sections.length < MAX_SECTION_DEPTH) {
        open({ type: 'details', open: piece.open, summary: [], children: [] })
      }
    } else if (piece.kind === 'close') {
      if (details) {
        stack.pop()
      } else {
        closeSectionWithContainer(stack)
      }
    } else if (piece.kind === 'summary' && details?.summary.length === 0) {
      details.summary = summaryPhrasing(piece.value)
    } else {
      current.children.push({ type: 'html', value: piece.value })
    }
  }
}

declare module 'mdast' {
  interface Details extends Parent {
    type: 'details'
    /** Authored `open`: the section starts expanded. */
    open: boolean
    summary: PhrasingContent[]
    children: (BlockContent | DefinitionContent)[]
  }
  interface RootContentMap {
    details: Details
  }
  interface BlockContentMap {
    details: Details
  }
}
