import { escapeMarkdownLinkDestination } from './adf-media-destination'

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

function textNode(text: string): JiraAdfRecord {
  return text ? { type: 'text', text } : { type: 'hardBreak' }
}

export function textToAdf(text: string): JiraAdfRecord {
  const lines = text.split(/\r?\n/)
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line ? [textNode(line)] : []
    }))
  }
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
  // Why: keep a visible marker when media cannot be downloaded so screenshots
  // are not silently dropped from the issue body.
  return `*[${label}]*`
}

/** Collect media attrs in document order (read-only; separate from adfToMarkdownText). */
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

function renderInline(node: unknown, options?: AdfToMarkdownOptions): string {
  if (!node) {
    return ''
  }
  if (typeof node === 'string') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map((child) => renderInline(child, options)).join('')
  }
  if (typeof node !== 'object') {
    return ''
  }

  const record = node as JiraAdfRecord
  if (typeof record.text === 'string') {
    return record.text
  }
  if (record.type === 'hardBreak') {
    return '\n'
  }
  // Why: Jira pastes screenshots as media/mediaInline ADF nodes; without this
  // branch they collapse to empty strings and disappear from the UI.
  if (record.type === 'media' || record.type === 'mediaInline') {
    return renderMediaMarkdown(record, options)
  }

  const attrs = asRecord(record.attrs)
  const fallbackText = asString(attrs.text) || asString(attrs.shortName) || asString(attrs.url)
  if (fallbackText) {
    return fallbackText
  }

  return renderInline(record.content, options)
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
      lines.push(`${prefix}${blockLines[0] ?? ''}`.trimEnd())
      blockLines.slice(1).forEach((line) => {
        lines.push(`${continuationIndent}${line}`.trimEnd())
      })
      return
    }

    if (block.kind !== 'list') {
      lines.push('')
    }
    blockLines.forEach((line) => {
      lines.push(`${continuationIndent}${line}`.trimEnd())
    })
  })

  return lines.join('\n')
}

function renderList(
  record: JiraAdfRecord,
  ordered: boolean,
  options?: AdfToMarkdownOptions
): string {
  const start = ordered ? positiveInteger(asRecord(record.attrs).order, 1) : 1
  return asArray(record.content)
    .map((item, index) => renderListItem(item, ordered ? `${start + index}. ` : '- ', options))
    .join('\n')
}

function renderCodeBlock(record: JiraAdfRecord, options?: AdfToMarkdownOptions): MarkdownBlock {
  const text = renderInline(record.content, options).replace(/\n$/, '')
  return { kind: 'block', text: ['```', text, '```'].join('\n') }
}

function renderBlockquote(record: JiraAdfRecord, options?: AdfToMarkdownOptions): MarkdownBlock {
  const text = joinBlocks(renderBlocks(record.content, options))
  return {
    kind: 'block',
    text: text
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
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
      text: `${prefix} ${renderInline(record.content, options).trim()}`.trim()
    }
  }
  if (type === 'bulletList') {
    // Why: Orca renders Jira bodies as Markdown, so ADF list containers need
    // concrete list markers instead of newline-only flattened text.
    return { kind: 'list', text: renderList(record, false, options) }
  }
  if (type === 'orderedList') {
    return { kind: 'list', text: renderList(record, true, options) }
  }
  if (type === 'listItem') {
    return { kind: 'list', text: renderListItem(record, '- ', options) }
  }
  if (type === 'codeBlock') {
    return renderCodeBlock(record, options)
  }
  if (type === 'blockquote') {
    return renderBlockquote(record, options)
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
    text: joinBlocks(renderBlocks(record.content, options)) || renderInline(record, options)
  }
}

export function adfToMarkdownText(value: unknown, options?: AdfToMarkdownOptions): string {
  return renderBlock(value, options)
    .text.replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
