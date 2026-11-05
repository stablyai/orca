import type { Nodes } from 'mdast'
import { describe, expect, it } from 'vitest'
import { parseMobileMarkdownTree } from './mobile-markdown-tree'

/** Formulas as `D:` (display) or `I:` (inline) plus the text drawn around them. */
function drawn(source: string): { math: string[]; text: string } {
  const math: string[] = []
  let text = ''
  const walk = (node: Nodes): void => {
    if (node.type === 'math') {
      math.push(`D:${node.value}`)
    } else if (node.type === 'inlineMath') {
      math.push(`I:${node.value}`)
    } else if (node.type === 'text') {
      text += node.value
    }
    if ('children' in node) {
      node.children.forEach(walk)
    }
  }
  walk(parseMobileMarkdownTree(source, false))
  return { math, text }
}

// Expected values are what desktop chat's remark grammar produces for the same source.
describe('math in mobile Markdown follows desktop chat', () => {
  it.each([
    [
      'the PR line-count cell',
      '$\\color{#1a7f37}{\\Huge{\\mathbf{+}}}$\u200b37',
      ['I:\\color{#1a7f37}{\\Huge{\\mathbf{+}}}'],
      '\u200b37'
    ],
    ['prices', '$10 and $20', [], '$10 and $20'],
    ['a price then a formula', '$5 $x$', ['I:x'], '$5 '],
    ['a block that interrupts a paragraph', 'para\n$$\nx=1\n$$\nafter', ['D:x=1'], 'paraafter'],
    ['display formulas alone in a paragraph', '$$a$$ $$b$$', ['D:a', 'D:b'], ''],
    ['a display opener among prose', '$$x$$ tail', ['I:x'], ' tail'],
    ['inline and bracket delimiters', '\\(a\\) and \\[b\\]', ['I:a', 'I:b'], ' and '],
    ['a citation', '\\[1, 2\\]', [], '[1, 2]'],
    ['an unclosed block', '$$\nunclosed', [], '$$\nunclosed'],
    ['a formula in a link label', '[$x$](http://a)', [], '$x$'],
    ['a closed math fence', '```math\nx^2\n```', ['D:x^2'], '']
  ])('%s', (_name, source, math, text) => {
    expect(drawn(source)).toEqual({ math, text })
  })
})
