// The Gmail message shape Orca reads, and what it takes from one: headers, text and attachments.
import { MIMEType } from 'node:util'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import type { GmailAttachment } from '../../shared/google/google-read-types'
import { htmlToText } from './google-html-text'

export type Part = {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: Part[]
}
export const PartSchema: z.ZodType<Part> = lazyZodSchema(() =>
  z.lazy(() =>
    z.object({
      partId: z.string().optional(),
      mimeType: z.string().optional(),
      filename: z.string().optional(),
      headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
      body: z
        .object({
          data: z.string().optional(),
          attachmentId: z.string().optional(),
          size: z.number().optional()
        })
        .optional(),
      parts: z.array(PartSchema).optional()
    })
  )
)
export const MessageSchema = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    threadId: z.string(),
    snippet: z.string().optional(),
    labelIds: z.array(z.string()).optional(),
    internalDate: z.string().optional(),
    payload: PartSchema.optional()
  })
)
export type Message = z.infer<typeof MessageSchema>
export const ThreadSchema = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    messages: z.array(MessageSchema).default([])
  })
)
export const ThreadListSchema = lazyZodSchema(() =>
  z.object({
    threads: z.array(z.object({ id: z.string() })).default([]),
    nextPageToken: z.string().optional(),
    resultSizeEstimate: z.number().optional()
  })
)

export const header = (message: Message, name: string): string | undefined =>
  message.payload?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value

export const sentAt = (message: Message): number => Number(message.internalDate ?? 0)

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf-8') : ''
}

function normalizeMimeHeader(value: string): string {
  const tokens: string[] = []
  let quoted = false
  let commentDepth = 0
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === '\\' && (quoted || commentDepth > 0)) {
      if (quoted) {
        tokens.push(character, value[index + 1] ?? '')
      }
      index++
    } else if (commentDepth > 0) {
      if (character === '(') commentDepth++
      if (character === ')') commentDepth--
    } else if (!quoted && character === '(') {
      commentDepth = 1
      tokens.push(' ')
    } else {
      if (character === '"') quoted = !quoted
      tokens.push(character)
    }
  }
  if (commentDepth > 0) {
    throw new SyntaxError('Unterminated MIME header comment')
  }
  return tokens
    .join('')
    .replace(/"(?:\\[\s\S]|[^"\\])*"?|[ \t\r\n]+/g, (token, offset: number, source: string) => {
      if (token.startsWith('"')) return token
      const before = source[offset - 1]
      const after = source[offset + token.length]
      return before === '=' || after === '=' || before === '/' || after === '/' ? '' : ' '
    })
}

function mixedBodyParts(children: Part[][], textOf: (part: Part) => string): Part[] {
  const plainCounts = new Map<string, number>()
  const equivalentText = (part: Part) => textOf(part).replace(/\s+/g, ' ').trim()
  for (const child of children) {
    if (child.length === 1 && child[0].mimeType === 'text/plain') {
      const text = equivalentText(child[0])
      plainCounts.set(text, (plainCounts.get(text) ?? 0) + 1)
    }
  }
  if (plainCounts.size === 0) return children.flat()
  return children
    .filter((child) => {
      if (child.length !== 1 || child[0].mimeType !== 'text/html') return true
      const text = equivalentText(child[0])
      const remaining = plainCounts.get(text) ?? 0
      if (remaining === 0) return true
      plainCounts.set(text, remaining - 1)
      return false
    })
    .flat()
}

/** Keep mixed sections in order; prefer plain text within each alternative. */
export function bodyText(part: Part | undefined): string {
  const decoded = new Map<Part, string>()
  const textOf = (node: Part): string => {
    const cached = decoded.get(node)
    if (cached !== undefined) return cached
    const source = decode(node.body?.data)
    const text = node.mimeType === 'text/html' ? htmlToText(source) : source
    decoded.set(node, text)
    return text
  }
  const select = (node: Part, relatedRoot = false): Part[] => {
    if (
      node.filename ||
      (!relatedRoot &&
        node.headers?.some(
          (entry) =>
            entry.name.toLowerCase() === 'content-disposition' &&
            /^\s*attachment(?=[\s;(]|$)/i.test(entry.value)
        ))
    ) {
      return []
    }
    if (node.mimeType === 'text/plain' || node.mimeType === 'text/html') {
      return [node]
    }
    if (node.mimeType === 'multipart/related') {
      // Related siblings are resources of one root, not independent body representations.
      const contentType = node.headers?.find(
        (entry) => entry.name.toLowerCase() === 'content-type'
      )?.value
      let contentId: string | null = null
      try {
        const normalized = normalizeMimeHeader(contentType ?? 'multipart/related')
        contentId = new MIMEType(normalized).params.get('start')
      } catch {
        // A missing or malformed header retains the implicit first-part root.
      }
      const root = contentId
        ? node.parts?.find((child) =>
            child.headers?.some(
              (entry) =>
                entry.name.toLowerCase() === 'content-id' && entry.value.trim() === contentId
            )
          )
        : node.parts?.[0]
      return root ? select(root, true) : []
    }
    const children = (node.parts ?? [])
      .map((child) => select(child))
      .filter((child) => child.length > 0)
    if (node.mimeType === 'multipart/alternative') {
      return (
        children.findLast((child) => child.some((leaf) => leaf.mimeType === 'text/plain')) ??
        children.at(-1) ??
        []
      )
    }
    return node.mimeType === 'multipart/mixed' ? mixedBodyParts(children, textOf) : children.flat()
  }
  return (part ? select(part) : []).map(textOf).join('\n').trim()
}

export function attachmentsOf(message: Message): GmailAttachment[] {
  const found: GmailAttachment[] = []
  const walk = (node: Part): void => {
    if (node.filename && node.body?.attachmentId && node.partId) {
      found.push({
        ref: `gmail:att:${message.id}:${node.partId}`,
        name: node.filename,
        ...(node.mimeType ? { type: node.mimeType } : {}),
        ...(node.body.size !== undefined ? { size: node.body.size } : {})
      })
    }
    node.parts?.forEach(walk)
  }
  if (message.payload) {
    walk(message.payload)
  }
  return found
}

export function findPart(node: Part | undefined, partId: string): Part | undefined {
  if (!node) {
    return undefined
  }
  if (node.partId === partId) {
    return node
  }
  for (const child of node.parts ?? []) {
    const found = findPart(child, partId)
    if (found) {
      return found
    }
  }
  return undefined
}
