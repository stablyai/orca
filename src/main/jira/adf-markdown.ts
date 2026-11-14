import type { Text } from 'mdast'
import type { JiraMediaMarkdown } from './adf-text-marks'
import { escapeMarkdownLinkDestination } from './adf-media-destination'
import { toMarkdown } from 'mdast-util-to-markdown'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { adfBlockNodes } from './adf-blocks'

type JiraAdfRecord = Record<string, unknown>

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

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
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

export function adfToMarkdownText(value: unknown, options?: AdfToMarkdownOptions): string {
  // Server/DC sends wiki strings rather than ADF; preserve its existing normalization.
  if (typeof value === 'string') {
    return value
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  const root = asRecord(value)
  const content = root.type === 'doc' ? root.content : [value]
  return toMarkdown(
    {
      type: 'root',
      children: adfBlockNodes(content, (node) => renderMediaMarkdown(node, options))
    },
    {
      extensions: [gfmToMarkdown()],
      bullet: '-',
      emphasis: '*',
      strong: '*',
      fences: true,
      listItemIndent: 'one',
      rule: '-',
      ruleSpaces: false,
      handlers: {
        jiraMedia: (node: JiraMediaMarkdown) => node.value,
        text: (node: Text, parent, state, info) =>
          state
            .safe(node.value, {
              ...info,
              beforeNode: parent?.children[(state.indexStack.at(-1) ?? 0) - 1],
              afterNode: parent?.children[(state.indexStack.at(-1) ?? 0) + 1]
            })
            .replace(/([\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, '$1_')
            .replace(/\\&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[\da-fA-F]+);)/g, '&')
      }
    }
  ).replace(/\n$/, '')
}
