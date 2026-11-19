import { escapeMarkdownLinkDestination } from './adf-media-destination'
import { renderAdfInline } from './adf-text-marks'
import { markdownTable } from 'markdown-table'

type JiraAdfRecord = Record<string, unknown>

type MarkdownBlock = {
  kind: 'block' | 'list'
  text: string
}

export type JiraAdfMediaAttrs = {
  id?: string
  url?: string
  alt?: string
  type?: string
}

/** Returns markdown for a media node (usually `![alt](src)`), or null to fall back. */
export type JiraAdfMediaResolver = (attrs: JiraAdfMediaAttrs) => string | null

export type AdfToMarkdownOptions = {
  resolveMedia?: JiraAdfMediaResolver
}

function asRecord(value: unknown): JiraAdfRecord {
  return value && typeof value === 'object' ? (value as JiraAdfRecord) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function headingLevel(value: unknown): number {
  return Math.min(Math.max(positiveInteger(value, 1), 1), 6)
}

export function escapeMarkdownAlt(text: string): string {
  return text.replace(/[[\]]/g, '')
}

function mediaAttrsFromRecord(record: JiraAdfRecord): JiraAdfMediaAttrs {
  const attrs = asRecord(record.attrs)
  return {
    id: asString(attrs.id) || undefined,
    url: asString(attrs.url) || undefined,
    alt: asString(attrs.alt) || asString(attrs.name) || undefined,
    type: asString(attrs.type) || undefined
  }
}

export function unresolvedMediaPlaceholder(attrs: JiraAdfMediaAttrs): string {
  const label = escapeMarkdownAlt(attrs.alt?.trim() || 'Image')
  // Preserve a visible marker when media cannot be downloaded.
  return `*[${label}]*`
}

/** Collect media attributes in document order without rendering. */
export function collectAdfMediaAttrs(value: unknown): JiraAdfMediaAttrs[] {
  const collected: JiraAdfMediaAttrs[] = []

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        walk(child)
      }
      return
    }
    const record = node as JiraAdfRecord
    if (record.type === 'media' || record.type === 'mediaInline') {
      collected.push(mediaAttrsFromRecord(record))
    }
    walk(record.content)
  }

  walk(value)
  return collected
}

function renderMediaMarkdown(
  record: JiraAdfRecord,
  options: AdfToMarkdownOptions | undefined
): string {
  const attrs = mediaAttrsFromRecord(record)
  const resolved = options?.resolveMedia?.(attrs)
  if (resolved) {
    return resolved
  }
  if (attrs.url && /^https?:\/\//i.test(attrs.url)) {
    const safeUrl = escapeMarkdownLinkDestination(attrs.url)
    if (!safeUrl) {
      return unresolvedMediaPlaceholder(attrs)
    }
    return `![${escapeMarkdownAlt(attrs.alt?.trim() || 'Image')}](${safeUrl})`
  }
  return unresolvedMediaPlaceholder(attrs)
}

function renderInline(
  value: unknown,
  options?: AdfToMarkdownOptions,
  inTable = false,
  heading = false
): string {
  return renderAdfInline(
    asArray(value),
    (node) => renderMediaMarkdown(node, options),
    inTable,
    heading
  )
}

function joinBlocks(blocks: MarkdownBlock[]): string {
  return blocks
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join('\n\n')
}

function renderBlocks(content: unknown, options?: AdfToMarkdownOptions): MarkdownBlock[] {
  return asArray(content)
    .map((node) => renderBlock(node, options))
    .filter((block) => block.text.length > 0)
}

function renderListItem(node: unknown, prefix: string, options?: AdfToMarkdownOptions): string {
  const blocks = renderBlocks(asRecord(node).content, options)
  if (blocks.length === 0) {
    return prefix.trimEnd()
  }

  const lines: string[] = []
  const continuationIndent = ' '.repeat(prefix.length)
  blocks.forEach((block, blockIndex) => {
    const blockLines = block.text.split('\n')
    if (blockIndex === 0) {
      lines.push(`${prefix}${blockLines[0] ?? ''}`)
      blockLines.slice(1).forEach((line) => {
        lines.push(line ? `${continuationIndent}${line}` : '')
      })
      return
    }

    if (block.kind !== 'list' && !block.text.startsWith('```')) {
      lines.push('')
    }
    blockLines.forEach((line) => {
      lines.push(line ? `${continuationIndent}${line}` : '')
    })
  })

  return lines.join('\n')
}

function renderList(
  record: JiraAdfRecord,
  ordered: boolean,
  options?: AdfToMarkdownOptions
): string {
  const order = asRecord(record.attrs).order
  const start =
    ordered && typeof order === 'number' && Number.isInteger(order) && order >= 0 ? order : 1
  return asArray(record.content)
    .map((item, index) => renderListItem(item, ordered ? `${start + index}. ` : '- ', options))
    .join('\n')
}

function renderCodeBlock(record: JiraAdfRecord): MarkdownBlock {
  const text = asArray(record.content)
    .map((child) => asString(asRecord(child).text))
    .join('')
  let longest = 2
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length)
  }
  const fence = '`'.repeat(longest + 1)
  const language = asString(asRecord(record.attrs).language).replace(/[\r\n`]/g, '')
  return { kind: 'block', text: `${fence}${language}\n${text}\n${fence}` }
}

function escapeTablePipes(value: string): string {
  const result: string[] = []
  let slashes = 0
  for (const char of value) {
    if (char === '|' && slashes % 2 === 0) {
      result.push('\\')
    }
    result.push(char)
    slashes = char === '\\' ? slashes + 1 : 0
  }
  return result.join('')
}

function renderTable(record: JiraAdfRecord, options?: AdfToMarkdownOptions): string | null {
  const rows: string[][] = []
  for (const rawRow of asArray(record.content)) {
    const cells: string[] = []
    for (const rawCell of asArray(asRecord(rawRow).content)) {
      const cell = asRecord(rawCell)
      const attrs = asRecord(cell.attrs)
      const blocks = asArray(cell.content)
      if (
        positiveInteger(attrs.colspan, 1) !== 1 ||
        positiveInteger(attrs.rowspan, 1) !== 1 ||
        blocks.length !== 1 ||
        asRecord(blocks[0]).type !== 'paragraph'
      ) {
        return null
      }
      const text = renderInline(asRecord(blocks[0]).content, options, true)
      cells.push(escapeTablePipes(text))
    }
    if (cells.length) {
      rows.push(cells)
    }
  }
  return rows.length ? markdownTable(rows, { alignDelimiters: false }) : ''
}

function renderBlockquote(record: JiraAdfRecord, options?: AdfToMarkdownOptions): MarkdownBlock {
  const text = joinBlocks(renderBlocks(record.content, options))
  return {
    kind: 'block',
    text: text
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n')
  }
}

function renderBlock(node: unknown, options?: AdfToMarkdownOptions): MarkdownBlock {
  if (typeof node === 'string') {
    return { kind: 'block', text: node }
  }
  if (Array.isArray(node)) {
    return { kind: 'block', text: joinBlocks(renderBlocks(node, options)) }
  }
  if (!node || typeof node !== 'object') {
    return { kind: 'block', text: '' }
  }

  const record = node as JiraAdfRecord
  const type = asString(record.type)
  if (type === 'doc') {
    return { kind: 'block', text: joinBlocks(renderBlocks(record.content, options)) }
  }
  if (type === 'paragraph') {
    return { kind: 'block', text: renderInline(record.content, options) }
  }
  if (type === 'heading') {
    const prefix = '#'.repeat(headingLevel(asRecord(record.attrs).level))
    return {
      kind: 'block',
      text: `${prefix} ${renderInline(record.content, options, false, true).trim()}`.trim()
    }
  }
  if (type === 'bulletList') {
    return { kind: 'list', text: renderList(record, false, options) }
  }
  if (type === 'orderedList') {
    return { kind: 'list', text: renderList(record, true, options) }
  }
  if (type === 'listItem') {
    return { kind: 'list', text: renderListItem(record, '- ', options) }
  }
  if (type === 'codeBlock') {
    return renderCodeBlock(record)
  }
  if (type === 'blockquote') {
    return renderBlockquote(record, options)
  }
  if (type === 'table') {
    const table = renderTable(record, options)
    if (table !== null) {
      return { kind: 'block', text: table }
    }
  }
  if (type === 'rule') {
    return { kind: 'block', text: '---' }
  }
  if (type === 'mediaSingle' || type === 'mediaGroup') {
    const mediaMarkdown = joinBlocks(renderBlocks(record.content, options))
    return { kind: 'block', text: mediaMarkdown }
  }
  if (type === 'media' || type === 'mediaInline') {
    return { kind: 'block', text: renderMediaMarkdown(record, options) }
  }

  return {
    kind: 'block',
    text: joinBlocks(renderBlocks(record.content, options)) || renderInline([record], options)
  }
}

export function adfToMarkdownText(value: unknown, options?: AdfToMarkdownOptions): string {
  if (typeof value === 'string') {
    return value
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  return renderBlock(value, options).text
}
