import MarkdownIt from 'markdown-it'
import cjkFriendly from 'markdown-it-cjk-friendly'
import footnote from 'markdown-it-footnote'
import type { AlignType, Parent, PhrasingContent, Root, RootContent, Table } from 'mdast'
import remend from 'remend'
import { forEachGitHubCallout } from '../../../src/shared/github/github-callouts'
import { codeNode, type Token } from './mobile-markdown-code-nodes'
import { inlineTagNode, inlineTagPairs } from './mobile-markdown-inline-html'
import { readTaskMarker } from './mobile-markdown-task-items'
import { plainText } from './mobile-markdown-plain-text'
import { appendHtmlBlock, noteInlineHtml, popContainer } from './mobile-markdown-details'
import { mobileMarkdownMath } from './mobile-markdown-math'
import {
  displayFormulas,
  inlineMathNode,
  mathBlockNode,
  mathClosed,
  mathFenceNode,
  withoutMath
} from './mobile-markdown-math-nodes'
import { withImagesSplitOut } from './mobile-markdown-html-images'
import { normalizeMobileMarkdownPreviewHtml } from './mobile-markdown-preview-html'
import { endLinkifyUrlsAtProsePunctuation } from './markdown-linkify-prose-boundary'

// Match desktop CommonMark/GFM tables, strikethrough, autolinks, footnotes and CJK emphasis using phone-efficient parser.
const markdown = new MarkdownIt({ html: true, linkify: true })
  .use(footnote)
  .use(cjkFriendly)
  .use(mobileMarkdownMath)
// Every href parses as a link, file: included; routeMarkdownHref decides what a tap opens.
markdown.validateLink = () => true
endLinkifyUrlsAtProsePunctuation(markdown.linkify)

/** markdown-it's env for every parse of one document; mobile-markdown-math reads `chatMath`. */
type MathEnv = { chatMath: boolean }

const PATH_FLANK = /[\w\\/]/
const LINE_BREAK_TAG = /^<br\s*\/?>$/i
const HEADING_DEPTHS = [1, 2, 3, 4, 5, 6] as const
/** Parents that hold blocks; any other parent holds inline content. */
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition', 'details'])
const CLOSING_TOKENS = new Set([
  'paragraph_close',
  'heading_close',
  'blockquote_close',
  'bullet_list_close',
  'ordered_list_close',
  'list_item_close',
  'table_close',
  'tr_close',
  'th_close',
  'td_close',
  'footnote_close'
])

function pushText(nodes: PhrasingContent[], value: string): void {
  if (!value) {
    return
  }
  const previous = nodes.at(-1)
  if (previous?.type === 'text') {
    previous.value += value
  } else {
    nodes.push({ type: 'text', value })
  }
}

/** Inline tokens up to `close`, and the index of that closing token. */
function phrasing(
  tokens: readonly Token[],
  start: number,
  close?: string
): { nodes: PhrasingContent[]; next: number } {
  const nodes: PhrasingContent[] = []
  let index = start
  while (index < tokens.length && tokens[index]!.type !== close) {
    const token = tokens[index]!
    index += 1
    if (token.type === 'text') {
      pushText(nodes, token.content)
    } else if (token.type === 'softbreak') {
      pushText(nodes, '\n')
    } else if (token.type === 'hardbreak') {
      nodes.push({ type: 'break' })
    } else if (token.type === 'code_inline') {
      nodes.push({ type: 'inlineCode', value: token.content })
    } else if (token.type === 'html_inline') {
      const pair = inlineTagPairs(tokens).get(index - 1)
      if (pair) {
        nodes.push(inlineTagNode(pair.tag, phrasing(tokens.slice(index, pair.close), 0).nodes))
        index = pair.close + 1
      } else {
        nodes.push({ type: 'html', value: token.content })
      }
    } else if (token.type === 'image') {
      nodes.push({ type: 'image', url: token.attrGet('src') ?? '', alt: token.content || null })
    } else if (token.type === 'math_inline') {
      nodes.push(inlineMathNode(token))
    } else if (token.type === 'footnote_ref') {
      const label = String(token.meta?.label ?? '')
      nodes.push({ type: 'footnoteReference', identifier: label, label })
    } else if (token.nesting === 1) {
      const inner = phrasing(tokens, index, token.type.replace(/_open$/, '_close'))
      index = inner.next + 1
      const previous = nodes.at(-1)
      const before = previous?.type === 'text' ? previous.value.slice(-1) : ''
      const after = tokens[index]?.type === 'text' ? (tokens[index]?.content[0] ?? '') : ''
      if (token.type === 'link_open') {
        nodes.push({
          type: 'link',
          url: token.attrGet('href') ?? '',
          children: withoutMath(inner.nodes)
        })
      } else if (
        // Keep underscore emphasis literal beside path separators so a/__tests__/x.ts remains whole/tappable.
        token.markup.startsWith('_') &&
        (PATH_FLANK.test(before) || PATH_FLANK.test(after))
      ) {
        const literal = inner.nodes.map(plainText).join('')
        pushText(nodes, `${token.markup}${literal}${token.markup}`)
      } else if (token.type === 'strong_open') {
        nodes.push({ type: 'strong', children: inner.nodes })
      } else if (token.type === 'em_open') {
        nodes.push({ type: 'emphasis', children: inner.nodes })
      } else if (token.type === 's_open') {
        nodes.push({ type: 'delete', children: inner.nodes })
      } else {
        nodes.push(...inner.nodes)
      }
    }
  }
  return { nodes, next: index }
}

function alignOf(token: Token): AlignType {
  const align = /text-align:\s*(left|right|center)/.exec(token.attrGet('style') ?? '')?.[1]
  return align === 'left' || align === 'right' || align === 'center' ? align : null
}

/** A `<details>` summary's inline HTML and Markdown as spans. */
function summaryPhrasing(html: string, env: MathEnv): PhrasingContent[] {
  // A summary is one line of spans; heading markup in it (`<h3>`) keeps only its text.
  const text = normalizeMobileMarkdownPreviewHtml(html).replace(/^\s*#{1,6}\s+/gm, '')
  return phrasing(markdown.parseInline(text, env)[0]?.children ?? [], 0).nodes
}

/** markdown-it's flat token stream as the mdast tree the renderer draws. */
function toTree(tokens: readonly Token[], source: string, env: MathEnv): Root {
  const root: Root = { type: 'root', children: [] }
  const lines = source.split('\n')
  const stack: Parent[] = [root]
  let table: Table | undefined
  const open = (node: Parent & RootContent): void => {
    stack.at(-1)!.children.push(node)
    stack.push(node)
  }
  for (const token of tokens) {
    const parent = stack.at(-1)!
    switch (token.type) {
      case 'paragraph_open':
        open({ type: 'paragraph', children: [] })
        break
      case 'heading_open':
        open({
          type: 'heading',
          depth: HEADING_DEPTHS.find((depth) => token.tag === `h${depth}`) ?? 6,
          children: []
        })
        break
      case 'blockquote_open':
        open({ type: 'blockquote', children: [] })
        break
      case 'bullet_list_open':
      case 'ordered_list_open':
        open({
          type: 'list',
          ordered: token.type === 'ordered_list_open',
          start: Number(token.attrGet('start') ?? 1),
          children: []
        })
        break
      case 'list_item_open':
        open({ type: 'listItem', checked: null, children: [] })
        break
      case 'table_open':
        table = { type: 'table', align: [], children: [] }
        open(table)
        break
      case 'tr_open':
        open({ type: 'tableRow', children: [] })
        break
      case 'th_open':
      case 'td_open':
        if (token.type === 'th_open') {
          table?.align?.push(alignOf(token))
        }
        open({ type: 'tableCell', children: [] })
        break
      case 'footnote_open': {
        const label = String(token.meta?.label ?? '')
        open({ type: 'footnoteDefinition', identifier: label, label, children: [] })
        break
      }
      case 'inline':
        parent.children.push(...phrasing(token.children ?? [], 0).nodes)
        noteInlineHtml(
          (token.children ?? []).flatMap((child) =>
            child.type === 'html_inline' ? [child.content] : []
          ),
          stack
        )
        break
      case 'fence':
      case 'code_block':
        parent.children.push(mathFenceNode(codeNode(token, lines)))
        break
      case 'math_block':
        parent.children.push(mathBlockNode(token))
        break
      case 'hr':
        parent.children.push({ type: 'thematicBreak' })
        break
      case 'html_block':
        appendHtmlBlock(token.content, stack, open, (html) => summaryPhrasing(html, env))
        break
      default:
        if (CLOSING_TOKENS.has(token.type)) {
          const container = stack.at(-2)
          const closed = popContainer(stack)
          if (closed?.type === 'listItem') {
            readTaskMarker(closed)
          } else if (closed?.type === 'paragraph' && container) {
            displayFormulas(container, closed)
          }
        }
    }
  }
  return root
}

// Clean only parser HTML nodes, never code: blocks become preview Markdown, inline tags become remaining text; nested leftover block HTML stays text.
function withoutHtml(parent: Parent, nested: boolean, env: MathEnv): void {
  const inline = !BLOCK_PARENTS.has(parent.type)
  parent.children = parent.children.flatMap((child): RootContent[] => {
    if (child.type !== 'html') {
      if ('children' in child) {
        withoutHtml(child, nested, env)
      }
      return [child]
    }
    if (inline && LINE_BREAK_TAG.test(child.value.trim())) {
      return [{ type: 'break' }]
    }
    // An https `<img>` draws as an image with its authored width; the HTML around it as before.
    return withImagesSplitOut(child.value).flatMap((piece): RootContent[] => {
      if (typeof piece !== 'string') {
        return inline ? [piece] : [{ type: 'paragraph', children: [piece] }]
      }
      const text = normalizeMobileMarkdownPreviewHtml(piece)
      if (!text) {
        return []
      }
      if (inline) {
        return [{ type: 'text', value: text }]
      }
      if (nested) {
        return [{ type: 'paragraph', children: [{ type: 'text', value: text }] }]
      }
      const blocks = toTree(markdown.parse(text, env), text, env)
      withoutHtml(blocks, true, env)
      return blocks.children
    })
  })
}

/** The text with the markup its last top-level block leaves open closed, as desktop closes it.
 *  Only that block: a lone `*` earlier in the reply is no opener, and remend would close it. */
function withLastBlockClosed(source: string, tokens: readonly Token[], chatMath: boolean): string {
  const last = tokens.findLast((token) => token.level === 0 && token.map)
  const lastBlock = last?.map?.[0] ?? 0
  const lines = source.split('\n')
  const tail = lines.slice(lastBlock).join('\n')
  // Like desktop, unfinished math stays as typed: remend would rewrite TeX as Markdown.
  const tailTokens = last ? tokens.slice(tokens.indexOf(last)) : []
  if (tailTokens.some((token) => !mathClosed(token)) || (chatMath && /\\[[(]/.test(tail))) {
    return source
  }
  const closed = remend(tail, { linkMode: 'text-only', katex: false })
  return closed === tail ? source : [...lines.slice(0, lastBlock), closed].join('\n')
}

/** `growing`: the text is still arriving, so markup its end leaves open is closed first, instead
 *  of flashing raw markers and half-written links. `chatMath`: chat's `\(` and `\[` math too. */
export function parseMobileMarkdownTree(source: string, growing: boolean, chatMath = false): Root {
  const env: MathEnv = { chatMath }
  let tokens = markdown.parse(source, env)
  let text = source
  if (growing) {
    text = withLastBlockClosed(source, tokens, chatMath)
    tokens = text === source ? tokens : markdown.parse(text, env)
  }
  const root = toTree(tokens, text, env)
  withoutHtml(root, false, env)
  // GitHub's `> [!NOTE]` alerts, read by desktop's rule.
  forEachGitHubCallout(root, (quote, kind) => {
    quote.data = { ...quote.data, callout: kind }
  })
  return root
}

/** The 0-based lines markdown-it reads as code, at any depth. */
export function mobileMarkdownCodeLines(source: string): Set<number> {
  const lines = new Set<number>()
  for (const token of markdown.parse(source, {})) {
    if ((token.type === 'fence' || token.type === 'code_block') && token.map) {
      for (let line = token.map[0]; line < token.map[1]; line += 1) {
        lines.add(line)
      }
    }
  }
  return lines
}
