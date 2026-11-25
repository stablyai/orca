// The Gmail message shape Orca reads, and what it takes from one: headers, text and attachments.
import { z } from 'zod'
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
export const PartSchema: z.ZodType<Part> = z.lazy(() =>
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
export const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
  payload: PartSchema.optional()
})
export type Message = z.infer<typeof MessageSchema>
export const ThreadSchema = z.object({
  id: z.string(),
  messages: z.array(MessageSchema).default([])
})
export const ThreadListSchema = z.object({
  threads: z.array(z.object({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional()
})

export const header = (message: Message, name: string): string | undefined =>
  message.payload?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value

export const sentAt = (message: Message): number => Number(message.internalDate ?? 0)

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf-8') : ''
}

/** The message's text: its plain part, else its HTML as text. */
export function bodyText(part: Part | undefined): string {
  const plain: string[] = []
  const html: string[] = []
  const walk = (node: Part): void => {
    if (node.filename) {
      return
    }
    if (node.mimeType === 'text/plain') {
      plain.push(decode(node.body?.data))
    } else if (node.mimeType === 'text/html') {
      html.push(decode(node.body?.data))
    }
    node.parts?.forEach(walk)
  }
  if (part) {
    walk(part)
  }
  return (plain.length > 0 ? plain.join('\n') : html.map(htmlToText).join('\n')).trim()
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
