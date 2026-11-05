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

const DETAILS_MARKUP =
  /<details\b([^>]*)>|<summary\b[^>]*>([\s\S]*?)<\/summary\s*>|<\/details\s*>/gi

/** One HTML block cut around its `<details>` markup, or null when it has none. */
function detailsPieces(html: string): DetailsPiece[] | null {
  const pieces: DetailsPiece[] = []
  let from = 0
  for (const match of html.matchAll(DETAILS_MARKUP)) {
    const text = html.slice(from, match.index)
    if (text.trim()) {
      pieces.push({ kind: 'html', value: text })
    }
    const [markup, attributes, summary] = match
    if (summary !== undefined) {
      pieces.push({ kind: 'summary', value: summary })
    } else if (markup.startsWith('</')) {
      pieces.push({ kind: 'close' })
    } else {
      pieces.push({ kind: 'open', open: /(?:^|\s)open(?:\s|=|$)/i.test(attributes ?? '') })
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

function isDetails(node: Parent): node is Details {
  return node.type === 'details'
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
    if (piece.kind === 'open') {
      open({ type: 'details', open: piece.open, summary: [], children: [] })
    } else if (piece.kind === 'close') {
      if (details) {
        stack.pop()
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
