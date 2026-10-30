// Per-upload directories preserve original filenames without collisions; atomic commit hides partial bytes.

import { randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { appendFile, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { extname, join } from 'node:path'
import {
  sanitizeAgentSessionAttachmentName,
  type AgentSessionAttachmentUploadCommitResult
} from '../../../shared/agent-session-attachments'
import type { RuntimeFilePreviewResult } from '../../../shared/runtime-types'
import { readAuthorizedDocPreviewFile } from '../../../shared/doc-preview-file-access'
import { renameFileWithWindowsRetryAsync } from '../../../shared/windows-retry-file-operations'
import { IMAGE_FILE_MIME_TYPES } from '../../../shared/image-file-extensions'
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
const FRESH_FILE_STREAM_HIGH_WATER_MARK = 1024 * 1024
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

  constructor(
    readonly rootDir: string,
    private readonly options: AgentSessionAttachmentStoreOptions
  ) {}

  isUploadInFlight(uploadId: string): boolean {
    return this.uploads.has(uploadId)
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
    const uploadDir = join(this.rootDir, randomUUID())
    const finalPath = join(uploadDir, sanitizeAgentSessionAttachmentName(name))
    try {
      await mkdir(uploadDir, { recursive: true })
      const partPath = join(uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE)
      await writeFile(partPath, bytes, { flag: 'wx' })
      await renameFileWithWindowsRetryAsync(partPath, finalPath)
    } catch (error) {
      await removeQuietly(uploadDir)
      throw error
    }
    return finalPath
  }

  /** Accept only trusted, unpublished 0600 snapshots, never arbitrary user paths. */
  async importFreshFile(name: string, sourcePath: string, byteLength: number): Promise<string> {
    const uploadDir = join(this.rootDir, randomUUID())
    const finalPath = join(uploadDir, sanitizeAgentSessionAttachmentName(name))
    try {
      await mkdir(uploadDir, { recursive: true })
      try {
        // Nothing fallible may follow rename: it transfers ownership of the source file.
        await renameFileWithWindowsRetryAsync(sourcePath, finalPath)
        return finalPath
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) {
          throw error
        }
      }
      const partPath = join(uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE)
      const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size !== byteLength) {
          throw new Error('Snapshot changed')
        }
        await (byteLength === 0
          ? writeFile(partPath, '', { flag: 'wx', mode: 0o600 })
          : pipeline(
              handle.createReadStream({
                start: 0,
                end: byteLength - 1,
                autoClose: false,
                highWaterMark: FRESH_FILE_STREAM_HIGH_WATER_MARK
              }),
              createWriteStream(partPath, {
                flags: 'wx',
                mode: 0o600,
                highWaterMark: FRESH_FILE_STREAM_HIGH_WATER_MARK
              })
            ))
        const after = await handle.stat()
        if (
          (await lstat(partPath)).size !== byteLength ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ino !== before.ino ||
          after.dev !== before.dev
        ) {
          throw new Error('Snapshot changed')
        }
      } finally {
        await handle.close()
      }
      await renameFileWithWindowsRetryAsync(partPath, finalPath)
      return finalPath
    } catch (error) {
      await removeQuietly(uploadDir)
      throw error
    }
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
  async readPreview(filePath: string, maxContentBytes?: number): Promise<RuntimeFilePreviewResult> {
    if (
      !IMAGE_FILE_MIME_TYPES[extname(filePath).toLowerCase()] ||
      !parseAgentSessionAttachmentStorePath(this.rootDir, filePath)
    ) {
      throw new Error(NOT_AN_IMAGE)
    }
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

export async function removeQuietly(path: string): Promise<void> {
  // Retry cleanup failures at the next sweep.
  await rm(path, { recursive: true, force: true }).catch(() => {})
}
