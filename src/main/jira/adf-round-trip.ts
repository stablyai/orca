import { isDeepStrictEqual } from 'node:util'
import { adfToMarkdownText } from './adf-markdown'
import { asRecord, asString, type JiraRecord as AdfNode } from './jira-record-pages'
import { markdownToAdf } from './markdown-adf'

const INLINE_CONTAINERS = new Set(['paragraph', 'heading'])

// Only the attributes Orca's Markdown can express; anything else must differ.
function normalizeAttrs(type: string, attrs: AdfNode): AdfNode | undefined {
  if (type === 'heading') {
    return { level: attrs.level }
  }
  if (type === 'orderedList') {
    return { order: typeof attrs.order === 'number' ? attrs.order : 1 }
  }
  if (type === 'codeBlock') {
    return asString(attrs.language) ? { language: attrs.language } : undefined
  }
  return undefined
}

function normalizeMarks(value: unknown): AdfNode[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined
  }
  return value
    .map((mark) => {
      const record = asRecord(mark)
      const type = asString(record.type)
      if (type === 'link') {
        return { type, href: asString(asRecord(record.attrs).href) }
      }
      return record.attrs === undefined ? { type } : { type, attrs: record.attrs }
    })
    .sort((left, right) => left.type.localeCompare(right.type))
}

function splitTextLines(node: AdfNode): AdfNode[] {
  if (node.type !== 'text' || !asString(node.text).includes('\n')) {
    return [node]
  }
  return asString(node.text)
    .split('\n')
    .flatMap((line, index) => [
      ...(index > 0 ? [{ type: 'hardBreak' }] : []),
      ...(line ? [{ ...node, text: line }] : [])
    ])
}

/** Applies the whitespace Markdown cannot keep: line-edge spaces and trailing breaks. */
function trimInline(nodes: AdfNode[]): AdfNode[] {
  const trimmed = nodes.map((node, index) => {
    if (node.type !== 'text') {
      return node
    }
    const lineStart = index === 0 || nodes[index - 1]?.type === 'hardBreak'
    const lineEnd = index === nodes.length - 1 || nodes[index + 1]?.type === 'hardBreak'
    let text = asString(node.text)
    text = lineStart ? text.replace(/^[ \t]+/, '') : text
    text = lineEnd ? text.replace(/[ \t]+$/, '') : text
    return { ...node, text }
  })
  const withText = trimmed.filter((node) => node.type !== 'text' || node.text !== '')
  while (withText.at(-1)?.type === 'hardBreak') {
    withText.pop()
  }
  return withText
}

function normalizeContent(parentType: string, content: unknown[]): AdfNode[] {
  let nodes = content.map(normalizeNode)
  if (parentType === 'codeBlock') {
    const last = nodes.at(-1)
    if (last?.type === 'text') {
      nodes[nodes.length - 1] = { ...last, text: asString(last.text).replace(/\n$/, '') }
    }
    return nodes
  }
  nodes = nodes.flatMap(splitTextLines)
  const merged: AdfNode[] = []
  for (const node of nodes) {
    const previous = merged.at(-1)
    if (
      node.type === 'text' &&
      previous?.type === 'text' &&
      isDeepStrictEqual(previous.marks, node.marks)
    ) {
      merged[merged.length - 1] = {
        ...previous,
        text: `${asString(previous.text)}${asString(node.text)}`
      }
    } else {
      merged.push(node)
    }
  }
  if (INLINE_CONTAINERS.has(parentType)) {
    return trimInline(merged)
  }
  // Orca drops empty paragraphs when it renders ADF, so they cannot round-trip.
  return merged.filter(
    (node) => node.type !== 'paragraph' || (Array.isArray(node.content) && node.content.length > 0)
  )
}

function normalizeNode(value: unknown): AdfNode {
  const record = asRecord(value)
  const type = asString(record.type)
  if (type === 'text') {
    const marks = normalizeMarks(record.marks)
    return marks
      ? { type, text: asString(record.text), marks }
      : { type, text: asString(record.text) }
  }
  const normalized: AdfNode = { type }
  const attrs = normalizeAttrs(type, asRecord(record.attrs))
  if (attrs) {
    normalized.attrs = attrs
  }
  if (Array.isArray(record.content)) {
    normalized.content = normalizeContent(type, record.content)
  }
  return normalized
}

/**
 * True when Orca can edit this ADF as Markdown and write it back without
 * dropping content Jira shows (media, mentions, panels, colors, tables, ...).
 */
export async function adfRoundTripsThroughMarkdown(adf: unknown): Promise<boolean> {
  const reparsed = await markdownToAdf(adfToMarkdownText(adf))
  return isDeepStrictEqual(normalizeNode(adf), normalizeNode(reparsed))
}
