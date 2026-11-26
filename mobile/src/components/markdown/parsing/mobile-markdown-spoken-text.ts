import type { Nodes } from 'mdast'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'

/** Read as a list of drawn words, not as content: code, formulas and markup are skipped. */
const UNSPOKEN = new Set(['code', 'math', 'inlineMath', 'html', 'thematicBreak', 'definition'])
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

/** plainText's reading, with the unspoken types dropped at every depth. */
function spokenText(node: Nodes): string {
  if (UNSPOKEN.has(node.type)) {
    return ''
  }
  if ('value' in node) {
    return node.value
  }
  if (node.type === 'image') {
    return node.alt ?? ''
  }
  return 'children' in node ? node.children.map(spokenText).join('') : ''
}

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
  const text = spokenText(node).replace(/\s+/g, ' ').trim()
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
