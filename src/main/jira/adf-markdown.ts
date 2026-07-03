type JiraAdfRecord = Record<string, unknown>

type MarkdownBlock = {
  kind: 'block' | 'list'
  text: string
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

function renderInline(node: unknown): string {
  if (!node) {
    return ''
  }
  if (typeof node === 'string') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map(renderInline).join('')
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

  const attrs = asRecord(record.attrs)
  const fallbackText = asString(attrs.text) || asString(attrs.shortName) || asString(attrs.url)
  if (fallbackText) {
    return fallbackText
  }

  return renderInline(record.content)
}

function joinBlocks(blocks: MarkdownBlock[]): string {
  return blocks
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join('\n\n')
}

function renderBlocks(content: unknown): MarkdownBlock[] {
  return asArray(content)
    .map(renderBlock)
    .filter((block) => block.text.length > 0)
}

function renderListItem(node: unknown, prefix: string): string {
  const blocks = renderBlocks(asRecord(node).content)
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

function renderList(record: JiraAdfRecord, ordered: boolean): string {
  const start = ordered ? positiveInteger(asRecord(record.attrs).order, 1) : 1
  return asArray(record.content)
    .map((item, index) => renderListItem(item, ordered ? `${start + index}. ` : '- '))
    .join('\n')
}

function renderCodeBlock(record: JiraAdfRecord): MarkdownBlock {
  const text = renderInline(record.content).replace(/\n$/, '')
  return { kind: 'block', text: ['```', text, '```'].join('\n') }
}

function renderBlockquote(record: JiraAdfRecord): MarkdownBlock {
  const text = joinBlocks(renderBlocks(record.content))
  return {
    kind: 'block',
    text: text
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
      .join('\n')
  }
}

function renderBlock(node: unknown): MarkdownBlock {
  if (typeof node === 'string') {
    return { kind: 'block', text: node }
  }
  if (Array.isArray(node)) {
    return { kind: 'block', text: joinBlocks(renderBlocks(node)) }
  }
  if (!node || typeof node !== 'object') {
    return { kind: 'block', text: '' }
  }

  const record = node as JiraAdfRecord
  const type = asString(record.type)
  if (type === 'doc') {
    return { kind: 'block', text: joinBlocks(renderBlocks(record.content)) }
  }
  if (type === 'paragraph') {
    return { kind: 'block', text: renderInline(record.content) }
  }
  if (type === 'heading') {
    const prefix = '#'.repeat(headingLevel(asRecord(record.attrs).level))
    return { kind: 'block', text: `${prefix} ${renderInline(record.content).trim()}`.trim() }
  }
  if (type === 'bulletList') {
    // Why: Orca renders Jira bodies as Markdown, so ADF list containers need
    // concrete list markers instead of newline-only flattened text.
    return { kind: 'list', text: renderList(record, false) }
  }
  if (type === 'orderedList') {
    return { kind: 'list', text: renderList(record, true) }
  }
  if (type === 'listItem') {
    return { kind: 'list', text: renderListItem(record, '- ') }
  }
  if (type === 'codeBlock') {
    return renderCodeBlock(record)
  }
  if (type === 'blockquote') {
    return renderBlockquote(record)
  }
  if (type === 'rule') {
    return { kind: 'block', text: '---' }
  }

  return { kind: 'block', text: joinBlocks(renderBlocks(record.content)) || renderInline(record) }
}

export function adfToMarkdownText(value: unknown): string {
  return renderBlock(value)
    .text.replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
