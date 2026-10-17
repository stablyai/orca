type AdfNode = Record<string, unknown>
type AdfMark = { type: string; attrs?: Record<string, unknown> }

// Structural subset of the mdast nodes remark-parse + remark-gfm produce.
type MdNode = {
  type: string
  value?: string
  children?: MdNode[]
  depth?: number
  ordered?: boolean | null
  start?: number | null
  checked?: boolean | null
  lang?: string | null
  url?: string
  alt?: string | null
  identifier?: string
  label?: string | null
}

type MarkdownParser = (markdown: string) => MdNode
type ConversionContext = { definitions: Map<string, string> }

// ADF only allows these block types inside list items and blockquotes.
const LIST_ITEM_BLOCKS = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock'])
const BLOCKQUOTE_BLOCKS = new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock'])

let parserLoad: Promise<MarkdownParser> | null = null

// Why: remark is ESM-only and only needed when Orca writes Jira Cloud text, so
// it loads on first use like the other ESM-only packages in main.
function loadMarkdownParser(): Promise<MarkdownParser> {
  parserLoad ??= Promise.all([import('unified'), import('remark-parse'), import('remark-gfm')])
    .then(([{ unified }, { default: remarkParse }, { default: remarkGfm }]) => {
      const processor = unified().use(remarkParse).use(remarkGfm)
      return (markdown: string): MdNode => processor.parse(markdown)
    })
    .catch((error: unknown) => {
      parserLoad = null
      throw error
    })
  return parserLoad
}

function collectDefinitions(node: MdNode, definitions: Map<string, string>): void {
  if (node.type === 'definition' && node.identifier && node.url) {
    definitions.set(node.identifier, node.url)
  }
  for (const child of node.children ?? []) {
    collectDefinitions(child, definitions)
  }
}

function withMark(marks: AdfMark[], mark: AdfMark): AdfMark[] {
  return marks.some((existing) => existing.type === mark.type) ? marks : [...marks, mark]
}

function textNodes(text: string, marks: AdfMark[]): AdfNode[] {
  const nodes: AdfNode[] = []
  // Why: Orca renders Jira bodies with remark-breaks, so a single newline is a
  // visible line break there; send it as hardBreak instead of a new paragraph.
  text.split('\n').forEach((line, index) => {
    if (index > 0) {
      nodes.push({ type: 'hardBreak' })
    }
    if (line) {
      nodes.push(
        marks.length > 0 ? { type: 'text', text: line, marks } : { type: 'text', text: line }
      )
    }
  })
  return nodes
}

function inlineNodes(
  nodes: MdNode[] | undefined,
  marks: AdfMark[],
  context: ConversionContext
): AdfNode[] {
  return (nodes ?? []).flatMap((node) => inlineNode(node, marks, context))
}

function inlineNode(node: MdNode, marks: AdfMark[], context: ConversionContext): AdfNode[] {
  switch (node.type) {
    case 'text':
    case 'html':
      return textNodes(node.value ?? '', marks)
    case 'inlineCode':
      // ADF lets `code` combine only with `link`.
      return textNodes((node.value ?? '').replace(/\n/g, ' '), [
        ...marks.filter((mark) => mark.type === 'link'),
        { type: 'code' }
      ])
    case 'break':
      return [{ type: 'hardBreak' }]
    case 'emphasis':
      return inlineNodes(node.children, withMark(marks, { type: 'em' }), context)
    case 'strong':
      return inlineNodes(node.children, withMark(marks, { type: 'strong' }), context)
    case 'delete':
      return inlineNodes(node.children, withMark(marks, { type: 'strike' }), context)
    case 'link':
      return inlineNodes(node.children, linkMarks(marks, node.url), context)
    case 'linkReference':
      return inlineNodes(
        node.children,
        linkMarks(marks, context.definitions.get(node.identifier ?? '')),
        context
      )
    case 'image':
    case 'imageReference': {
      const url = node.url ?? context.definitions.get(node.identifier ?? '')
      return textNodes(node.alt || url || '', linkMarks(marks, url))
    }
    case 'footnoteReference':
      return textNodes(`[^${node.label ?? node.identifier ?? ''}]`, marks)
    default:
      return node.children
        ? inlineNodes(node.children, marks, context)
        : textNodes(node.value ?? '', marks)
  }
}

// Script-capable or relative destinations keep their label as plain text.
const SAFE_LINK_PATTERN = /^(?:https?:\/\/|mailto:)/i

function linkMarks(marks: AdfMark[], url: string | undefined): AdfMark[] {
  return url && SAFE_LINK_PATTERN.test(url)
    ? withMark(marks, { type: 'link', attrs: { href: url } })
    : marks
}

function paragraph(content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content }
}

/** Rewrites blocks a container cannot hold into ones it can, keeping their text. */
function fitBlocks(blocks: AdfNode[], allowed: ReadonlySet<string>): AdfNode[] {
  return blocks.flatMap((block) => {
    const type = typeof block.type === 'string' ? block.type : ''
    if (allowed.has(type)) {
      return [block]
    }
    const content = Array.isArray(block.content) ? block.content : []
    if (type === 'heading') {
      return [paragraph(content)]
    }
    return fitBlocks(content, allowed)
  })
}

function listItemNode(node: MdNode, context: ConversionContext): AdfNode {
  const content = fitBlocks(blockNodes(node.children, context), LIST_ITEM_BLOCKS)
  if (content[0]?.type !== 'paragraph') {
    content.unshift(paragraph([]))
  }
  if (typeof node.checked !== 'boolean') {
    return { type: 'listItem', content }
  }
  // Task-list checkboxes have no ADF list-item equivalent; keep them as text.
  const [first, ...rest] = content
  const inline = Array.isArray(first?.content) ? first.content : []
  const checkbox = { type: 'text', text: node.checked ? '[x] ' : '[ ] ' }
  return { type: 'listItem', content: [paragraph([checkbox, ...inline]), ...rest] }
}

function listNode(node: MdNode, context: ConversionContext): AdfNode {
  const items = (node.children ?? []).map((item) => listItemNode(item, context))
  if (!node.ordered) {
    return { type: 'bulletList', content: items }
  }
  const start = typeof node.start === 'number' && node.start > 0 ? node.start : 1
  return {
    type: 'orderedList',
    ...(start === 1 ? {} : { attrs: { order: start } }),
    content: items
  }
}

function tableNode(node: MdNode, context: ConversionContext): AdfNode {
  return {
    type: 'table',
    content: (node.children ?? []).map((row, rowIndex) => ({
      type: 'tableRow',
      content: (row.children ?? []).map((cell) => ({
        type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
        content: [paragraph(inlineNodes(cell.children, [], context))]
      }))
    }))
  }
}

function blockNodes(nodes: MdNode[] | undefined, context: ConversionContext): AdfNode[] {
  return (nodes ?? []).flatMap((node) => blockNode(node, context))
}

function blockNode(node: MdNode, context: ConversionContext): AdfNode[] {
  switch (node.type) {
    case 'paragraph':
      return [paragraph(inlineNodes(node.children, [], context))]
    case 'heading':
      return [
        {
          type: 'heading',
          attrs: { level: Math.min(Math.max(node.depth ?? 1, 1), 6) },
          content: inlineNodes(node.children, [], context)
        }
      ]
    case 'thematicBreak':
      return [{ type: 'rule' }]
    case 'blockquote':
      return [
        {
          type: 'blockquote',
          content: fitBlocks(blockNodes(node.children, context), BLOCKQUOTE_BLOCKS)
        }
      ]
    case 'list':
      return [listNode(node, context)]
    case 'code':
      return [
        {
          type: 'codeBlock',
          ...(node.lang ? { attrs: { language: node.lang } } : {}),
          content: node.value ? [{ type: 'text', text: node.value }] : []
        }
      ]
    case 'table':
      return [tableNode(node, context)]
    case 'definition':
      return []
    case 'html':
      return node.value?.trim() ? [paragraph(textNodes(node.value, []))] : []
    default:
      return node.children
        ? blockNodes(node.children, context)
        : node.value
          ? [paragraph(textNodes(node.value, []))]
          : []
  }
}

/** Converts Markdown typed in Orca into the ADF document Jira Cloud (REST v3) stores. */
export async function markdownToAdf(markdown: string): Promise<AdfNode> {
  const parse = await loadMarkdownParser()
  const root = parse(markdown)
  const context: ConversionContext = { definitions: new Map() }
  collectDefinitions(root, context.definitions)
  return { type: 'doc', version: 1, content: blockNodes(root.children, context) }
}
