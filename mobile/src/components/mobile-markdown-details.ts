import type { Details, Parent, PhrasingContent, RootContent } from 'mdast'

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

const DETAILS_TAG = /<\/?(?:details|summary)[\s/>]/i
const DETAILS_SECTION_TAG = /<\/?details[\s/>]/i
const DETAILS_CLOSE = /^<\/details\s*>$/i

/** Whether the text opens or closes a `<details>` section; a lone `<summary>` (C# doc comments) does neither. */
export function hasDetailsSectionTag(text: string): boolean {
  return DETAILS_SECTION_TAG.test(text)
}

/** One HTML block cut around its `<details>` markup. */
function detailsPieces(html: string): DetailsPiece[] {
  if (!DETAILS_TAG.test(html)) {
    return [{ kind: 'html', value: html }]
  }
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
  for (let top = stack.at(-1); isDetails(top) && top.closesWithContainer; top = stack.at(-1)) {
    stack.pop()
  }
  return closed
}

/** Like a browser, `</details>` inside a paragraph or list item ends the innermost section when
 *  that container ends. */
function closeSectionWithContainer(stack: Parent[]): void {
  const section = stack.findLast(isDetails)
  if (section) {
    section.closesWithContainer = true
  }
}

/** A `</details>` among a paragraph's inline HTML closes the section with the paragraph. */
export function noteInlineHtml(htmls: readonly string[], stack: Parent[]): void {
  if (htmls.some((html) => DETAILS_CLOSE.test(html))) {
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
  for (const piece of detailsPieces(html)) {
    const current = stack.at(-1)!
    const details = isDetails(current) ? current : null
    if (piece.kind === 'open') {
      if (stack.filter(isDetails).length < MAX_SECTION_DEPTH) {
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
