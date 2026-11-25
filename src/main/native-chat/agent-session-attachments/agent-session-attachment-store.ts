// Per-upload directories preserve original filenames without collisions; atomic commit hides partial bytes.

import { readAttachmentTextChunk } from './agent-session-attachment-text-read'
import type { AttachmentTextRequest } from '../../../shared/attachment-text/attachment-text-source'
import { createHash, randomUUID } from 'node:crypto'
import { access, appendFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  sanitizeAgentSessionAttachmentName,
  type AgentSessionAttachmentUploadCommitResult
} from '../../../shared/agent-session/agent-session-attachments'
import type { RuntimeFilePreviewResult } from '../../../shared/file-content/runtime-file-read'
import { readAuthorizedDocPreviewFile } from '../../../shared/document-preview/doc-preview-file-access'
import { renameFileWithWindowsRetryAsync } from '../../../shared/file-write/windows-retry-file-operations'
import { IMAGE_FILE_MIME_TYPES } from '../../../shared/file-preview/image-mime-types'
import {
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  assertPreviewWithinTransportBudget,
  previewableBinaryByteLimit
} from '../../runtime/files/file-preview-budget'
import { ChunkedUploadRegistry, nextChunkedUploadLength } from './chunked-upload-registry'
import {
  AGENT_SESSION_ATTACHMENT_PART_FILE,
  parseAgentSessionAttachmentStorePath
} from './agent-session-attachment-references'

const UPLOAD_MAX_CONCURRENT = 8
const UPLOAD_IDLE_TTL_MS = 5 * 60 * 1000
const NOT_FOUND = 'Attachment upload was not found'
const NOT_AN_IMAGE = 'Not an attachment image'
const PREVIEW_TOO_LARGE = 'file_too_large'

function isTooLarge(error: unknown): boolean {
  return error instanceof Error && error.message === PREVIEW_TOO_LARGE
}

type InFlightUpload = {
  callerKey: string
  uploadDir: string
  name: string
  expectedLength: number
  receivedLength: number
  writing: boolean
}

export type AgentSessionAttachmentStoreOptions = {
  hasSession: (sessionId: string) => boolean
}

export class AgentSessionAttachmentStore {
  private readonly uploads = new ChunkedUploadRegistry<InFlightUpload>({
    maxConcurrent: UPLOAD_MAX_CONCURRENT,
    ttlMs: UPLOAD_IDLE_TTL_MS,
    tooManyMessage: 'Too many attachment uploads are in progress',
    notFoundMessage: NOT_FOUND,
    onExpire: (upload) => void removeQuietly(upload.uploadDir)
  })

  // Latest content write per folder, and pending writes by file so a re-send queues nothing.
  private readonly contentWrites = new Map<string, Promise<void>>()
  private readonly pendingContent = new Set<string>()

  constructor(
    readonly rootDir: string,
    private readonly options: AgentSessionAttachmentStoreOptions
  ) {}

  isUploadInFlight(uploadId: string): boolean {
    return this.uploads.has(uploadId) || this.contentWrites.has(uploadId)
  }

  async startUpload(args: {
    callerKey: string
    sessionId: string
    name: string
    byteLength: number
  }): Promise<{ uploadId: string }> {
    if (!this.options.hasSession(args.sessionId)) {
      throw new Error('This chat is not on this host')
    }
    const name = sanitizeAgentSessionAttachmentName(args.name)
    const uploadId = this.uploads.create((id) => ({
      callerKey: args.callerKey,
      uploadDir: join(this.rootDir, id),
      name,
      expectedLength: args.byteLength,
      receivedLength: 0,
      writing: false
    }))
    const uploadDir = join(this.rootDir, uploadId)
    try {
      await mkdir(uploadDir, { recursive: true })
      await writeFile(join(uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE), '', { flag: 'wx' })
    } catch (error) {
      this.uploads.delete(uploadId)
      await removeQuietly(uploadDir)
      throw error
    }
    return { uploadId }
  }

  async appendChunk(args: {
    callerKey: string
    uploadId: string
    offset: number
    contentBase64: string
  }): Promise<{ receivedBytes: number }> {
    const upload = this.requireOwned(args.uploadId, args.callerKey)
    if (upload.writing) {
      throw new Error('Attachment chunk is already being written')
    }
    const bytes = Buffer.from(args.contentBase64, 'base64')
    const nextLength = nextChunkedUploadLength(upload, args.offset, bytes.byteLength, {
      outOfOrder: 'Attachment chunk offset is out of order',
      exceeded: 'Attachment upload exceeded its declared size'
    })
    upload.writing = true
    try {
      await appendFile(join(upload.uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE), bytes)
      upload.receivedLength = nextLength
    } finally {
      upload.writing = false
    }
    this.uploads.touch(args.uploadId)
    return { receivedBytes: upload.receivedLength }
  }

  async commitUpload(args: {
    callerKey: string
    uploadId: string
  }): Promise<AgentSessionAttachmentUploadCommitResult> {
    const upload = this.requireOwned(args.uploadId, args.callerKey)
    if (upload.writing) {
      throw new Error('Attachment chunk is still being written')
    }
    // Keep uploads in flight until rename so slow commits cannot race part-file sweeping.
    upload.writing = true
    try {
      if (upload.receivedLength !== upload.expectedLength) {
        throw new Error('Attachment upload is incomplete')
      }
      const finalPath = join(upload.uploadDir, upload.name)
      // Retry transient Windows antivirus/indexer holds instead of discarding the upload.
      await renameFileWithWindowsRetryAsync(
        join(upload.uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE),
        finalPath
      )
      return { path: finalPath, name: upload.name, byteLength: upload.receivedLength }
    } catch (error) {
      await removeQuietly(upload.uploadDir)
      throw error
    } finally {
      this.uploads.delete(args.uploadId)
    }
  }

  /** Fresh files rely on the sweep's one-hour grace rather than in-flight tracking. */
  async storeFile(name: string, bytes: Buffer): Promise<string> {
    return this.storeWith(name, (partPath) => writeFile(partPath, bytes, { flag: 'wx' }))
  }

  /** One committed upload whose hidden part file `write` fills, renamed into place; returns its
   *  path. Not in flight meanwhile: the sweep leaves a folder this new alone for an hour. */
  async storeWith(name: string, write: (partPath: string) => Promise<void>): Promise<string> {
    const uploadDir = join(this.rootDir, randomUUID())
    const finalPath = join(uploadDir, sanitizeAgentSessionAttachmentName(name))
    try {
      await mkdir(uploadDir, { recursive: true })
      const partPath = join(uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE)
      await write(partPath)
      // Rename is the commit: nothing fallible may follow it.
      await renameFileWithWindowsRetryAsync(partPath, finalPath)
    } catch (error) {
      await removeQuietly(uploadDir)
      throw error
    }
    return finalPath
  }

  /** Same bytes on the same UTC day, same path, so a re-sent image keeps one file. A reused folder is
   *  at most a day old, so the sweep cannot have marked it. The write finishes in the background;
   *  reads of the path wait for it through `whenWritten`. */
  storeContent(bytes: Buffer, extension: string): string {
    const day = Math.floor(Date.now() / (24 * 60 * 60 * 1000))
    const digest = createHash('sha256').update(bytes).update(`:${day}`).digest('hex')
    const uploadId = [
      digest.slice(0, 8),
      digest.slice(8, 12),
      digest.slice(12, 16),
      digest.slice(16, 20),
      digest.slice(20, 32)
    ].join('-')
    const uploadDir = join(this.rootDir, uploadId)
    const path = join(uploadDir, `image${extension}`)
    if (this.pendingContent.has(path)) {
      return path
    }
    // One write per folder at a time: concurrent ones would share its part file.
    const written = (this.contentWrites.get(uploadId) ?? Promise.resolve())
      .then(() => writeContent(uploadDir, path, bytes))
      // Once more, in case a sweep removed a crash-left part folder mid-write.
      .catch(() => writeContent(uploadDir, path, bytes))
      .catch(() => {})
    this.contentWrites.set(uploadId, written)
    this.pendingContent.add(path)
    void written.then(() => {
      this.pendingContent.delete(path)
      if (this.contentWrites.get(uploadId) === written) {
        this.contentWrites.delete(uploadId)
      }
    })
    return path
  }

  /** Settles once a pending `storeContent` write of this store path has finished or failed. */
  async whenWritten(filePath: string): Promise<void> {
    const uploadId = parseAgentSessionAttachmentStorePath(this.rootDir, filePath)?.uploadId
    await (uploadId ? this.contentWrites.get(uploadId) : undefined)
  }

  async abortUpload(args: { callerKey: string; uploadId: string }): Promise<{ aborted: true }> {
    const upload = this.uploads.peek(args.uploadId)
    if (upload) {
      if (upload.callerKey !== args.callerKey) {
        throw new Error(NOT_FOUND)
      }
      this.uploads.delete(args.uploadId)
      await removeQuietly(upload.uploadDir)
    }
    return { aborted: true }
  }

  /** Refuse out-of-store paths and previews exceeding the remote reply budget. */
  readTextChunk(request: AttachmentTextRequest, maxContentBytes?: number) {
    return readAttachmentTextChunk(this.rootDir, request, maxContentBytes)
  }

  async readPreview(filePath: string, maxContentBytes?: number): Promise<RuntimeFilePreviewResult> {
    if (
      !IMAGE_FILE_MIME_TYPES[extname(filePath).toLowerCase()] ||
      !parseAgentSessionAttachmentStorePath(this.rootDir, filePath)
    ) {
      throw new Error(NOT_AN_IMAGE)
    }
    await this.whenWritten(filePath)
    let read: Awaited<ReturnType<typeof readAuthorizedDocPreviewFile>>
    try {
      read = await readAuthorizedDocPreviewFile({
        boundaryPath: this.rootDir,
        entryPath: filePath,
        implicitRootPath: null,
        authorizedRootPaths: [],
        targetPath: filePath,
        maxTextBytes: 0,
        maxBinaryBytes:
          maxContentBytes === undefined
            ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
            : previewableBinaryByteLimit(maxContentBytes)
      })
    } catch (error) {
      // Uniform failures reveal nothing about unrelated server files.
      throw new Error(isTooLarge(error) ? PREVIEW_TOO_LARGE : NOT_AN_IMAGE)
    }
    if (!read.isBinary || !read.mimeType?.startsWith('image/')) {
      throw new Error(NOT_AN_IMAGE)
    }
    return assertPreviewWithinTransportBudget(
      { content: read.content, isBinary: true, isImage: true, mimeType: read.mimeType },
      maxContentBytes
    )
  }

  clearInFlightForTests(): void {
    this.uploads.clear()
  }

  private requireOwned(uploadId: string, callerKey: string): InFlightUpload {
    const upload = this.uploads.require(uploadId)
    // Do not reveal another caller's upload existence.
    if (upload.callerKey !== callerKey) {
      throw new Error(NOT_FOUND)
    }
    return upload
  }
}

async function writeContent(uploadDir: string, path: string, bytes: Buffer): Promise<void> {
  if (
    await access(path).then(
      () => true,
      () => false
    )
  ) {
    return
  }
  const partPath = join(uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE)
  try {
    await mkdir(uploadDir, { recursive: true })
    await writeFile(partPath, bytes)
    await renameFileWithWindowsRetryAsync(partPath, path)
  } catch (error) {
    // Leave no part-only folder for a later write of the same bytes to reuse while the sweep removes it.
    const entries = await readdir(uploadDir).catch(() => [])
    if (entries.every((entry) => entry === AGENT_SESSION_ATTACHMENT_PART_FILE)) {
      await removeQuietly(uploadDir)
    }
    throw error
  }
}

export async function removeQuietly(path: string): Promise<void> {
  // Retry cleanup failures at the next sweep.
  await rm(path, { recursive: true, force: true }).catch(() => {})
}
