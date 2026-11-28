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

function normalizeMimeHeader(value: string, isContentId = false): string {
  const tokens: string[] = []
  let quoted = false
  let commentDepth = 0
  let domainLiteral = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === '\\' && (quoted || commentDepth > 0 || domainLiteral)) {
      if (quoted || domainLiteral) {
        tokens.push(character, value[index + 1] ?? '')
      }
      index++
    } else if (commentDepth > 0) {
      if (character === '(') {
        commentDepth++
      }
      if (character === ')') {
        commentDepth--
      }
    } else if (isContentId && !quoted && (domainLiteral || character === '[')) {
      domainLiteral = character !== ']'
      tokens.push(character)
    } else if (!quoted && character === '(') {
      commentDepth = 1
      tokens.push(' ')
    } else {
      if (character === '"') {
        quoted = !quoted
      }
      tokens.push(character)
    }
  }
  if (commentDepth > 0 || domainLiteral) {
    return ''
  }
  return tokens
    .join('')
    .replace(/"(?:\\[\s\S]|[^"\\])*"?|[ \t\r\n]+/g, (token, offset: number, source: string) => {
      if (token.startsWith('"')) {
        return token
      }
      const before = source[offset - 1]
      const after = source[offset + token.length]
      return before === '=' || after === '=' || before === '/' || after === '/' ? '' : ' '
    })
}

function isAttachment(node: Part): boolean {
  return Boolean(
    node.filename ||
    node.headers?.some(
      (entry) =>
        entry.name.toLowerCase() === 'content-disposition' &&
        /^\s*attachment(?=[\s;(]|$)/i.test(normalizeMimeHeader(entry.value) || entry.value)
    )
  )
}

function mixedBodyParts(
  children: { mimeType?: string; parts?: Part[]; leaves: Part[] }[],
  textOf: (part: Part) => string
): Part[] {
  // Only a direct text root makes related transparent. Explicit nested groups remain
  // independent sections even when selection leaves only one text part.
  const representations = children.map((child) =>
    child.leaves.length === 1 &&
    (['text/plain', 'text/html'].includes(child.mimeType ?? '') ||
      (child.mimeType === 'multipart/related' && child.parts?.includes(child.leaves[0])))
      ? child.leaves[0]
      : undefined
  )
  if (!representations.some((part) => part?.mimeType === 'text/html')) {
    return children.flatMap((child) => child.leaves)
  }
  const pairedPlain = new Set<number>()
  const omitted = new Set<number>()
  const equivalentText = (part: Part) => textOf(part).replace(/\s+/g, ' ').trim()
  representations.forEach((part, index) => {
    if (part?.mimeType !== 'text/html') {
      return
    }
    const html = equivalentText(part)
    // Do not pair across another visible section: its position is meaningful in mixed mail.
    const neighbors = [index - 1, index + 1].flatMap((neighbor) => {
      const plain = representations[neighbor]
      return plain?.mimeType === 'text/plain' && !pairedPlain.has(neighbor)
        ? [{ index: neighbor, text: equivalentText(plain) }]
        : []
    })
    const exact = neighbors.find((neighbor) => neighbor.text === html)
    const match = exact ?? neighbors.find((neighbor) => containsCompleteBody(html, neighbor.text))
    if (match) {
      // Prefer equality on either side; containment retains the richer HTML representation.
      omitted.add(exact ? index : match.index)
      pairedPlain.add(match.index)
    }
  })
  return children.filter((_, index) => !omitted.has(index)).flatMap((child) => child.leaves)
}

function containsCompleteBody(html: string, plain: string): boolean {
  if (!plain) {
    return false
  }
  const wordStart = /^[\p{L}\p{M}\p{N}_\u200c\u200d]/u
  const wordEnd = /[\p{L}\p{M}\p{N}_\u200c\u200d]$/u
  const startsWithWord = wordStart.test(plain)
  const endsWithWord = wordEnd.test(plain)
  // Prefix fallback visits overlapping matches without rescanning long repeated bodies.
  const fallback = new Uint32Array(plain.length)
  for (let index = 1, matched = 0; index < plain.length; index++) {
    while (matched > 0 && plain[index] !== plain[matched]) {
      matched = fallback[matched - 1]
    }
    if (plain[index] === plain[matched]) {
      matched++
    }
    fallback[index] = matched
  }
  for (let index = 0, matched = 0; index < html.length; index++) {
    while (matched > 0 && html[index] !== plain[matched]) {
      matched = fallback[matched - 1]
    }
    if (html[index] === plain[matched]) {
      matched++
    }
    if (matched !== plain.length) {
      continue
    }
    const at = index + 1 - matched
    if (
      (!startsWithWord || !wordEnd.test(html.slice(Math.max(0, at - 2), at))) &&
      (!endsWithWord || !wordStart.test(html.slice(at + plain.length, at + plain.length + 2)))
    ) {
      return true
    }
    matched = fallback[matched - 1]
  }
  return false
}

/** Keep mixed sections in order; prefer plain text within each alternative. */
export function bodyText(part: Part | undefined): string {
  const decoded = new Map<Part, string>()
  const textOf = (node: Part): string => {
    const cached = decoded.get(node)
    if (cached !== undefined) {
      return cached
    }
    const source = decode(node.body?.data)
    const text = node.mimeType === 'text/html' ? htmlToText(source) : source
    decoded.set(node, text)
    return text
  }
  const select = (node: Part, relatedRoot = false): Part[] => {
    if (!relatedRoot && isAttachment(node)) {
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
      const selectedRoot = contentId
        ? node.parts?.find((child) =>
            child.headers?.some(
              (entry) =>
                entry.name.toLowerCase() === 'content-id' &&
                normalizeMimeHeader(entry.value, true).trim() === contentId
            )
          )
        : undefined
      // Recover a missing or malformed root reference without treating related resources as bodies.
      const root = selectedRoot ?? node.parts?.[0]
      return root ? select(root, true) : []
    }
    const children = (node.parts ?? [])
      .filter((child) => !isAttachment(child))
      .map((child) => ({ mimeType: child.mimeType, parts: child.parts, leaves: select(child) }))
      .filter((child) => child.leaves.length > 0 || child.mimeType?.startsWith('multipart/'))
    if (node.mimeType === 'multipart/alternative') {
      const readable = children.filter(
        (child) =>
          child.leaves.length > 0 &&
          child.leaves.every((leaf) => leaf.body?.data !== undefined || !leaf.body?.attachmentId)
      )
      return (
        readable.findLast((child) => child.leaves.some((leaf) => leaf.mimeType === 'text/plain'))
          ?.leaves ??
        readable.at(-1)?.leaves ??
        []
      )
    }
    return node.mimeType === 'multipart/mixed'
      ? mixedBodyParts(children, textOf)
      : children.flatMap((child) => child.leaves)
  }
  return (part ? select(part) : []).map(textOf).join('\n').trim()
}

export function attachmentsOf(message: Message): GmailAttachment[] {
  const found: GmailAttachment[] = []
  const walk = (node: Part): void => {
    const body = node.body
    if (node.filename && body && (body.attachmentId || body.data !== undefined) && node.partId) {
      found.push({
        ref: `gmail:att:${message.id}:${node.partId}`,
        name: node.filename,
        ...(node.mimeType ? { type: node.mimeType } : {}),
        ...(body.size !== undefined ? { size: body.size } : {})
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
