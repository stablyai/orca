import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute } from 'node:path'
import type {
  NativeChatImageRefBlock,
  NativeChatMessage
} from '../../shared/native-chat/native-chat-types'
import { IMAGE_FILE_MIME_TYPES } from '../../shared/image-file-extensions'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES } from '../runtime/files/file-preview-budget'
import { getAgentSessionAttachmentStore } from './agent-session-attachments/agent-session-attachment-store-registry'
import { takePendingToolResultImages, type ToolResultImageSource } from './transcript-record-blocks'

const SPOOL_BASE64_MAX_CHARS = Math.ceil(RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES / 3) * 4 + 8

export type ToolImageSpool = (bytes: Buffer, extension: string) => string | null

export function toolInputFilePath(input: unknown): string | null {
  const record = asRecord(input) ?? (typeof input === 'string' ? parseJsonObject(input) : null)
  if (!record) {
    return null
  }
  return (
    extractString(record.file_path) ??
    extractString(record.filePath) ??
    extractString(record.path) ??
    null
  )
}

export function resolveToolResultImageRefs(args: {
  sources: readonly ToolResultImageSource[]
  filePath?: string | null
  spool?: ToolImageSpool
}): NativeChatImageRefBlock[] {
  if (args.sources.length === 0) {
    return []
  }
  const paired = existingImageFile(args.filePath)
  let usedPaired = false
  const refs: NativeChatImageRefBlock[] = []
  for (const source of args.sources) {
    const ownPath = existingImageFile(source.path)
    if (ownPath) {
      refs.push(imageRef(ownPath, undefined, source.alt))
      continue
    }
    if (source.url && /^https?:\/\//i.test(source.url)) {
      refs.push(imageRef(undefined, source.url, source.alt))
      continue
    }
    const bytes = source.base64 ? decodeImageBytes(source.base64) : null
    if (
      paired &&
      !usedPaired &&
      !source.path &&
      !source.url &&
      bytes &&
      matchesFile(paired, bytes)
    ) {
      usedPaired = true
      refs.push(imageRef(paired, undefined, source.alt))
      continue
    }
    const extension = bytes ? imageExtension(bytes) : null
    if (!bytes || !extension) {
      continue
    }
    const stored = spoolImage(bytes, extension, args.spool)
    if (stored) {
      refs.push(imageRef(stored, undefined, source.alt))
    }
  }
  return refs
}

function matchesFile(path: string, bytes: Buffer): boolean {
  try {
    return statSync(path).size === bytes.length && readFileSync(path).equals(bytes)
  } catch {
    return false
  }
}

/** Pair tool-result images with the call's file path before the messages leave the host. */
export function attachResolvedToolImages(
  messages: NativeChatMessage[],
  spool?: ToolImageSpool
): NativeChatMessage[] {
  const paths = new Map<string, string>()
  let changed = false
  const next = messages.map((message) => {
    for (const block of message.blocks) {
      if (block.type === 'tool-call' && block.callId) {
        const path = toolInputFilePath(block.input)
        if (path) {
          paths.set(block.callId, path)
        }
      }
    }
    const extras: NativeChatImageRefBlock[] = []
    for (const block of message.blocks) {
      const sources = takePendingToolResultImages(block)
      if (!sources?.length || block.type !== 'tool-result') {
        continue
      }
      extras.push(
        ...resolveToolResultImageRefs({
          sources,
          filePath: block.callId ? paths.get(block.callId) : undefined,
          spool
        })
      )
    }
    if (extras.length === 0) {
      return message
    }
    changed = true
    return { ...message, blocks: [...message.blocks, ...extras] }
  })
  return changed ? next : messages
}

export function acpToolImageRefs(update: {
  content?:
    | readonly {
        type?: string
        content?: { type?: string; data?: string; mimeType?: string | null; uri?: string | null }
      }[]
    | null
  rawInput?: unknown
  locations?: readonly { path?: string | null }[] | null
}): NativeChatImageRefBlock[] {
  const content = update.content
  if (!content) {
    return []
  }
  const sources: ToolResultImageSource[] = []
  for (const block of content) {
    if (block.type !== 'content' || block.content?.type !== 'image') {
      continue
    }
    const data = block.content.data
    const uri = block.content.uri
    const path = typeof uri === 'string' && isAbsolute(uri) ? uri : undefined
    if (!data && !path) {
      continue
    }
    sources.push({
      ...(path ? { path } : {}),
      ...(data ? { base64: data } : {}),
      ...(block.content.mimeType ? { mediaType: block.content.mimeType } : {})
    })
  }
  if (sources.length === 0) {
    return []
  }
  const location = update.locations?.find((entry) => entry.path && isAbsolute(entry.path))?.path
  return resolveToolResultImageRefs({
    sources,
    filePath: location ?? toolInputFilePath(update.rawInput)
  })
}

function imageRef(
  path: string | undefined,
  url: string | undefined,
  alt: string | undefined
): NativeChatImageRefBlock {
  const label = alt || (path ? basename(path) : undefined)
  return {
    type: 'image-ref',
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    ...(label ? { alt: label } : {})
  }
}

function existingImageFile(filePath: string | null | undefined): string | null {
  if (
    !filePath ||
    !isAbsolute(filePath) ||
    !IMAGE_FILE_MIME_TYPES[extname(filePath).toLowerCase()]
  ) {
    return null
  }
  try {
    return statSync(filePath).isFile() ? filePath : null
  } catch {
    return null
  }
}

function decodeImageBytes(base64: string): Buffer | null {
  if (base64.length === 0 || base64.length > SPOOL_BASE64_MAX_CHARS) {
    return null
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength > RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES) {
    return null
  }
  return bytes
}

function imageExtension(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return '.png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return '.jpg'
  }
  if (bytes.length >= 6) {
    const gif = bytes.toString('ascii', 0, 6)
    if (gif === 'GIF87a' || gif === 'GIF89a') {
      return '.gif'
    }
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return '.webp'
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return '.bmp'
  }
  return null
}

function spoolImage(
  bytes: Buffer,
  extension: string,
  spool: ToolImageSpool | undefined
): string | null {
  try {
    return (spool ?? defaultSpool)(bytes, extension)
  } catch {
    return null
  }
}

function defaultSpool(bytes: Buffer, extension: string): string | null {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const name = `chat-image-${hash}${extension}`
  return getAgentSessionAttachmentStore()?.storeImageOnce(name, bytes) ?? null
}
