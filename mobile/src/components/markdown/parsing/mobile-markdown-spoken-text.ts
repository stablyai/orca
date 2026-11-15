import type { Nodes } from 'mdast'
import { plainText } from './mobile-markdown-plain-text'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'

/** Read as a list of drawn words, not as content: code, formulas and markup are skipped. */
const UNSPOKEN = new Set(['code', 'math', 'html', 'thematicBreak', 'definition'])
/** Parents whose children are read one block per line. */
const BLOCK_PARENTS = new Set([
  'root',
  'blockquote',
  'list',
  'listItem',
  'table',
  'tableRow',
  'details',
  'footnoteDefinition'
])

function spokenBlocks(node: Nodes, into: string[]): void {
  if (UNSPOKEN.has(node.type)) {
    return
  }
  if (BLOCK_PARENTS.has(node.type) && 'children' in node) {
    for (const child of node.children) {
      spokenBlocks(child, into)
    }
    return
  }
  const text = plainText(node).trim()
  if (text) {
    into.push(text)
  }
}

/** A message's markdown as words to speak: no markers, link targets or code blocks. */
export function mobileMarkdownSpokenText(markdown: string): string {
  const blocks: string[] = []
  spokenBlocks(parseMobileMarkdownTree(markdown, false, true), blocks)
  return blocks.join('\n')
}
