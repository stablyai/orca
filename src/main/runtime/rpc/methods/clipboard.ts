import { z } from 'zod'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { saveClipboardImageBufferAsTempFile } from '../../../window/clipboard-image-temp-file'
import { randomUUID } from 'node:crypto'
import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR
} from '../../../../shared/clipboard-image'
import { recordMobileClipboardImagePath } from '../mobile-clipboard-image-provenance'

const MAX_CLIPBOARD_IMAGE_BASE64_CHARS = CLIPBOARD_IMAGE_MAX_BASE64_CHARS
export const CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
export const CLIPBOARD_IMAGE_UPLOAD_MAX_CONCURRENT = 8
const CLIPBOARD_IMAGE_UPLOAD_TTL_MS = 5 * 60 * 1000
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

type ClipboardImageUpload = {
  expectedBase64Length: number
  connectionId?: string | null
  mobileClientId?: string
  chunks: string[]
  receivedBase64Length: number
  expiresAt: number
  ttlTimer: ReturnType<typeof setTimeout>
}

const clipboardImageUploads = new Map<string, ClipboardImageUpload>()

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
    clipboardImageUploads.delete(uploadId)
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

function deleteUpload(uploadId: string): void {
  const upload = clipboardImageUploads.get(uploadId)
  if (upload) {
    clearTimeout(upload.ttlTimer)
  }
  clipboardImageUploads.delete(uploadId)
}

function getUpload(uploadId: string): ClipboardImageUpload {
  pruneExpiredUploads()
  const upload = clipboardImageUploads.get(uploadId)
  if (!upload) {
    throw new Error('Clipboard image upload was not found')
  }
  return upload
}

function mobileClientId(ctx: RpcContext): string | undefined {
  if (ctx.clientKind !== 'mobile') {
    return undefined
  }
  const clientId = ctx.clientId?.trim()
  if (!clientId) {
    throw new Error('Clipboard image upload requires an authenticated mobile client')
  }
  return clientId
}

function assertMobileUploadOwner(
  upload: ClipboardImageUpload,
  ctx: RpcContext
): string | undefined {
  const clientId = mobileClientId(ctx)
  if (clientId && upload.mobileClientId !== clientId) {
    throw new Error('Clipboard image upload was not found')
  }
  return clientId
}

function assertValidBase64Content(value: string): void {
  if (!isValidBase64(value)) {
    throw new Error('Clipboard image content must be base64')
  }
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
    handler: async (params, ctx) => {
      const clientId = mobileClientId(ctx)
      const path = await saveClipboardImageBufferAsTempFile(
        Buffer.from(params.contentBase64, 'base64'),
        {
          connectionId: params.connectionId
        }
      )
      if (clientId && !params.connectionId) {
        recordMobileClipboardImagePath(clientId, path)
      }
      return path
    }
  }),
  defineMethod({
    name: 'clipboard.startImageUpload',
    params: StartImageUpload,
    handler: (params, ctx) => {
      pruneExpiredUploads()
      if (clipboardImageUploads.size >= CLIPBOARD_IMAGE_UPLOAD_MAX_CONCURRENT) {
        throw new Error('Too many clipboard image uploads are in progress')
      }
      const uploadId = randomUUID()
      clipboardImageUploads.set(uploadId, {
        expectedBase64Length: params.expectedBase64Length,
        connectionId: params.connectionId,
        mobileClientId: mobileClientId(ctx),
        chunks: [],
        receivedBase64Length: 0,
        expiresAt: Date.now() + CLIPBOARD_IMAGE_UPLOAD_TTL_MS,
        ttlTimer: scheduleUploadExpiry(uploadId)
      })
      return { uploadId }
    }
  }),
  defineMethod({
    name: 'clipboard.appendImageUploadChunk',
    params: AppendImageUploadChunk,
    handler: (params, ctx) => {
      const upload = getUpload(params.uploadId)
      assertMobileUploadOwner(upload, ctx)
      if (params.offset !== upload.receivedBase64Length) {
        throw new Error('Clipboard image chunk offset is out of order')
      }
      const nextLength = upload.receivedBase64Length + params.contentBase64.length
      if (nextLength > upload.expectedBase64Length) {
        throw new Error('Clipboard image upload exceeded expected size')
      }
      upload.chunks.push(params.contentBase64)
      upload.receivedBase64Length = nextLength
      refreshUploadExpiry(params.uploadId, upload)
      return { receivedBase64Length: upload.receivedBase64Length }
    }
  }),
  defineMethod({
    name: 'clipboard.commitImageUpload',
    params: CommitImageUpload,
    handler: async (params, ctx) => {
      const upload = getUpload(params.uploadId)
      const clientId = assertMobileUploadOwner(upload, ctx)
      try {
        if (upload.receivedBase64Length !== upload.expectedBase64Length) {
          throw new Error('Clipboard image upload is incomplete')
        }
        const contentBase64 = upload.chunks.join('')
        assertValidBase64Content(contentBase64)
        const path = await saveClipboardImageBufferAsTempFile(
          Buffer.from(contentBase64, 'base64'),
          {
            connectionId: upload.connectionId
          }
        )
        if (clientId && !upload.connectionId) {
          recordMobileClipboardImagePath(clientId, path)
        }
        return path
      } finally {
        // Why: failed SSH or filesystem commits must not leave bounded upload
        // memory pinned until TTL cleanup.
        deleteUpload(params.uploadId)
      }
    }
  }),
  defineMethod({
    name: 'clipboard.abortImageUpload',
    params: AbortImageUpload,
    handler: (params, ctx) => {
      pruneExpiredUploads()
      const upload = clipboardImageUploads.get(params.uploadId)
      if (upload) {
        assertMobileUploadOwner(upload, ctx)
      }
      deleteUpload(params.uploadId)
      return { aborted: true }
    }
  })
]

export function resetClipboardImageUploadsForTest(): void {
  for (const uploadId of clipboardImageUploads.keys()) {
    deleteUpload(uploadId)
  }
}
