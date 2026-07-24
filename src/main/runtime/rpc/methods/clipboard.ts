import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { saveClipboardImageBufferAsTempFile } from '../../../window/clipboard-image-temp-file'
import { randomUUID } from 'node:crypto'
import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR
} from '../../../../shared/clipboard-image'
import { ClipboardImageUploadBuffer } from './clipboard-image-upload-buffer'

const MAX_CLIPBOARD_IMAGE_BASE64_CHARS = CLIPBOARD_IMAGE_MAX_BASE64_CHARS
export const CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
export const CLIPBOARD_IMAGE_UPLOAD_MAX_CONCURRENT = 8
export const CLIPBOARD_IMAGE_UPLOAD_MAX_RETAINED_BASE64_CHARS = CLIPBOARD_IMAGE_MAX_BASE64_CHARS
const CLIPBOARD_IMAGE_UPLOAD_TTL_MS = 5 * 60 * 1000
const CLIPBOARD_IMAGE_UPLOAD_MEMORY_ERROR = 'Too much clipboard image upload data is in progress'
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

type ClipboardImageUpload = {
  expectedBase64Length: number
  connectionId?: string | null
  content: ClipboardImageUploadBuffer
  reservedBase64Length: number
  expiresAt: number
  ttlTimer: ReturnType<typeof setTimeout>
  committing: boolean
}

const clipboardImageUploads = new Map<string, ClipboardImageUpload>()
let retainedClipboardImageUploadBase64Chars = 0

function isValidBase64(value: string): boolean {
  return value.length % 4 !== 1 && BASE64_PATTERN.test(value)
}

function pruneExpiredUploads(now = Date.now()): void {
  for (const [uploadId, upload] of clipboardImageUploads) {
    if (upload.expiresAt <= now) {
      deleteUpload(uploadId)
    }
  }
}

function scheduleUploadExpiry(uploadId: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    deleteUpload(uploadId)
  }, CLIPBOARD_IMAGE_UPLOAD_TTL_MS)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
  return timer
}

function refreshUploadExpiry(uploadId: string, upload: ClipboardImageUpload): void {
  clearTimeout(upload.ttlTimer)
  upload.expiresAt = Date.now() + CLIPBOARD_IMAGE_UPLOAD_TTL_MS
  upload.ttlTimer = scheduleUploadExpiry(uploadId)
}

function releaseUploadRetention(upload: ClipboardImageUpload): void {
  retainedClipboardImageUploadBase64Chars -= upload.reservedBase64Length
  upload.reservedBase64Length = 0
  upload.content.clear()
}

function finishUpload(uploadId: string, upload: ClipboardImageUpload): void {
  clearTimeout(upload.ttlTimer)
  if (clipboardImageUploads.get(uploadId) === upload) {
    clipboardImageUploads.delete(uploadId)
  }
  releaseUploadRetention(upload)
}

function deleteUpload(uploadId: string): void {
  const upload = clipboardImageUploads.get(uploadId)
  if (!upload || upload.committing) {
    return
  }
  finishUpload(uploadId, upload)
}

function getUpload(uploadId: string): ClipboardImageUpload {
  pruneExpiredUploads()
  const upload = clipboardImageUploads.get(uploadId)
  if (!upload) {
    throw new Error('Clipboard image upload was not found')
  }
  if (upload.committing) {
    throw new Error('Clipboard image upload is already committing')
  }
  return upload
}

function reserveUploadBase64(chars: number): boolean {
  if (
    chars >
    CLIPBOARD_IMAGE_UPLOAD_MAX_RETAINED_BASE64_CHARS - retainedClipboardImageUploadBase64Chars
  ) {
    return false
  }
  retainedClipboardImageUploadBase64Chars += chars
  return true
}

function clipboardImageBase64Payload(maxChars: number, tooLargeMessage: string) {
  return z.unknown().transform((value, ctx): string => {
    if (typeof value !== 'string') {
      ctx.addIssue({ code: 'custom', message: 'Missing image content' })
      return z.NEVER
    }
    if (value.length > maxChars) {
      ctx.addIssue({ code: 'custom', message: tooLargeMessage })
      return z.NEVER
    }
    if (!isValidBase64(value)) {
      ctx.addIssue({ code: 'custom', message: 'Clipboard image content must be base64' })
      return z.NEVER
    }
    return value
  })
}

const SaveImageAsTempFile = z.object({
  contentBase64: clipboardImageBase64Payload(
    MAX_CLIPBOARD_IMAGE_BASE64_CHARS,
    CLIPBOARD_IMAGE_TOO_LARGE_ERROR
  ),
  connectionId: z.string().min(1).nullable().optional()
})

const StartImageUpload = z.object({
  expectedBase64Length: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_CLIPBOARD_IMAGE_BASE64_CHARS, CLIPBOARD_IMAGE_TOO_LARGE_ERROR),
  connectionId: z.string().min(1).nullable().optional()
})

const AppendImageUploadChunk = z.object({
  uploadId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  contentBase64: clipboardImageBase64Payload(
    CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
    'Clipboard image chunk is too large'
  )
})

const CommitImageUpload = z.object({
  uploadId: z.string().min(1)
})

const AbortImageUpload = z.object({
  uploadId: z.string().min(1)
})

export const CLIPBOARD_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'clipboard.saveImageAsTempFile',
    params: SaveImageAsTempFile,
    handler: async (params) =>
      saveClipboardImageBufferAsTempFile(Buffer.from(params.contentBase64, 'base64'), {
        connectionId: params.connectionId
      })
  }),
  defineMethod({
    name: 'clipboard.startImageUpload',
    params: StartImageUpload,
    handler: (params) => {
      pruneExpiredUploads()
      if (clipboardImageUploads.size >= CLIPBOARD_IMAGE_UPLOAD_MAX_CONCURRENT) {
        throw new Error('Too many clipboard image uploads are in progress')
      }
      const uploadId = randomUUID()
      clipboardImageUploads.set(uploadId, {
        expectedBase64Length: params.expectedBase64Length,
        connectionId: params.connectionId,
        content: new ClipboardImageUploadBuffer(
          params.expectedBase64Length,
          CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
        ),
        reservedBase64Length: 0,
        expiresAt: Date.now() + CLIPBOARD_IMAGE_UPLOAD_TTL_MS,
        ttlTimer: scheduleUploadExpiry(uploadId),
        committing: false
      })
      return { uploadId }
    }
  }),
  defineMethod({
    name: 'clipboard.appendImageUploadChunk',
    params: AppendImageUploadChunk,
    handler: (params) => {
      const upload = getUpload(params.uploadId)
      if (params.offset !== upload.content.length) {
        throw new Error('Clipboard image chunk offset is out of order')
      }
      const nextLength = upload.content.length + params.contentBase64.length
      if (nextLength > upload.expectedBase64Length) {
        throw new Error('Clipboard image upload exceeded expected size')
      }
      if (!reserveUploadBase64(params.contentBase64.length)) {
        throw new Error(CLIPBOARD_IMAGE_UPLOAD_MEMORY_ERROR)
      }
      try {
        upload.content.append(params.contentBase64)
      } catch (error) {
        retainedClipboardImageUploadBase64Chars -= params.contentBase64.length
        throw error
      }
      upload.reservedBase64Length += params.contentBase64.length
      refreshUploadExpiry(params.uploadId, upload)
      return { receivedBase64Length: upload.content.length }
    }
  }),
  defineMethod({
    name: 'clipboard.commitImageUpload',
    params: CommitImageUpload,
    handler: async (params) => {
      const upload = getUpload(params.uploadId)
      upload.committing = true
      clearTimeout(upload.ttlTimer)
      try {
        if (upload.content.length !== upload.expectedBase64Length) {
          throw new Error('Clipboard image upload is incomplete')
        }
        const content = upload.content.decode()
        upload.content.clear()
        return await saveClipboardImageBufferAsTempFile(content, {
          connectionId: upload.connectionId
        })
      } finally {
        finishUpload(params.uploadId, upload)
      }
    }
  }),
  defineMethod({
    name: 'clipboard.abortImageUpload',
    params: AbortImageUpload,
    handler: (params) => {
      deleteUpload(params.uploadId)
      return { aborted: true }
    }
  })
]

export function resetClipboardImageUploadsForTest(): void {
  for (const [uploadId, upload] of clipboardImageUploads) {
    finishUpload(uploadId, upload)
  }
  retainedClipboardImageUploadBase64Chars = 0
}

export function getRetainedClipboardImageUploadBase64CharsForTest(): number {
  return retainedClipboardImageUploadBase64Chars
}
