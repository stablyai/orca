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

/** Keep mixed sections in order; prefer plain text within each alternative. */
export function bodyText(part: Part | undefined): string {
  const select = (node: Part): Part[] => {
    if (node.filename) {
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
        contentId = new MIMEType(contentType ?? 'multipart/related').params.get('start')
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
      return root ? select(root) : []
    }
    const children = (node.parts ?? []).map(select).filter((child) => child.length > 0)
    if (node.mimeType === 'multipart/alternative') {
      return (
        children.findLast((child) => child.some((leaf) => leaf.mimeType === 'text/plain')) ??
        children.at(-1) ??
        []
      )
    }
    return children.flat()
  }
  return (part ? select(part) : [])
    .map((node) => {
      const text = decode(node.body?.data)
      return node.mimeType === 'text/html' ? htmlToText(text) : text
    })
    .join('\n')
    .trim()
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
