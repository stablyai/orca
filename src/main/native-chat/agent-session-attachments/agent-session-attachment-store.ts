// Per-upload directories preserve original filenames without collisions; atomic commit hides partial bytes.

import { readAttachmentTextChunk } from './agent-session-attachment-text-read'
import type { AttachmentTextRequest } from '../../../shared/attachment-text-source'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  sanitizeAgentSessionAttachmentName,
  type AgentSessionAttachmentUploadCommitResult
} from '../../../shared/agent-session/agent-session-attachments'
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
const NOT_FOUND = 'Attachment upload was not found'
const NOT_AN_IMAGE = 'Not an attachment image'
const PREVIEW_TOO_LARGE = 'file_too_large'
const NOT_ON_HOST = 'This chat is not on this host'
const LAUNCH_ENDED = 'This chat was not started, so its attachment was not kept'

function isTooLarge(error: unknown): boolean {
  return error instanceof Error && error.message === PREVIEW_TOO_LARGE
}

/** The caller's live prepared launch standing in for the chat it founds; its uploads die with it. */
export type AgentSessionAttachmentLaunchAuthority = {
  live: () => boolean
  ended: AbortSignal
}

type InFlightUpload = {
  callerKey: string
  uploadDir: string
  name: string
  expectedLength: number
  receivedLength: number
  writing: boolean
  launch?: AgentSessionAttachmentLaunchAuthority
  unwatch?: () => void
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
    onExpire: (upload) => {
      upload.unwatch?.()
      void removeQuietly(upload.uploadDir)
    }
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
    launch?: AgentSessionAttachmentLaunchAuthority
  }): Promise<{ uploadId: string }> {
    // A prepared launch stands in for the chat it founds; nothing else does.
    if (args.launch ? !args.launch.live() : !this.options.hasSession(args.sessionId)) {
      throw new Error(NOT_ON_HOST)
    }
    const name = sanitizeAgentSessionAttachmentName(args.name)
    const uploadId = this.uploads.create((id) => ({
      callerKey: args.callerKey,
      uploadDir: join(this.rootDir, id),
      name,
      expectedLength: args.byteLength,
      receivedLength: 0,
      writing: false,
      ...(args.launch ? { launch: args.launch } : {})
    }))
    const uploadDir = join(this.rootDir, uploadId)
    try {
      await mkdir(uploadDir, { recursive: true })
      await writeFile(join(uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE), '', { flag: 'wx' })
      // The launch may have ended while its upload was being allocated.
      if (args.launch && !args.launch.live()) {
        throw new Error(LAUNCH_ENDED)
      }
    } catch (error) {
      this.forget(uploadId)
      await removeQuietly(uploadDir)
      throw error
    }
    this.watchLaunch(uploadId)
    return { uploadId }
  }

  async appendChunk(args: {
    callerKey: string
    uploadId: string
    offset: number
    contentBase64: string
  }): Promise<{ receivedBytes: number }> {
    const upload = await this.requireLive(args.uploadId, args.callerKey)
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
    await this.requireLive(args.uploadId, args.callerKey)
    this.uploads.touch(args.uploadId)
    return { receivedBytes: upload.receivedLength }
  }

  async commitUpload(args: {
    callerKey: string
    uploadId: string
  }): Promise<AgentSessionAttachmentUploadCommitResult> {
    const upload = await this.requireLive(args.uploadId, args.callerKey)
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
      this.forget(args.uploadId)
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

  async abortUpload(args: { callerKey: string; uploadId: string }): Promise<{ aborted: true }> {
    const upload = this.uploads.peek(args.uploadId)
    if (upload) {
      if (upload.callerKey !== args.callerKey) {
        throw new Error(NOT_FOUND)
      }
      this.forget(args.uploadId)
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

  private forget(uploadId: string): void {
    this.uploads.delete(uploadId)?.unwatch?.()
  }

  /** An unfinished part dies with its launch, not at idle expiry; a write in progress rechecks. */
  private watchLaunch(uploadId: string): void {
    const upload = this.uploads.peek(uploadId)
    const ended = upload?.launch?.ended
    if (!upload || !ended) {
      return
    }
    const onEnded = (): void => {
      if (this.uploads.peek(uploadId) === upload && !upload.writing) {
        this.forget(uploadId)
        void removeQuietly(upload.uploadDir)
      }
    }
    ended.addEventListener('abort', onEnded, { once: true })
    upload.unwatch = () => ended.removeEventListener('abort', onEnded)
  }

  /** The caller's upload, refused and removed once the launch it was made for has ended. */
  private async requireLive(uploadId: string, callerKey: string): Promise<InFlightUpload> {
    const upload = this.requireOwned(uploadId, callerKey)
    if (upload.launch && !upload.launch.live()) {
      this.forget(uploadId)
      await removeQuietly(upload.uploadDir)
      throw new Error(LAUNCH_ENDED)
    }
    return upload
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
