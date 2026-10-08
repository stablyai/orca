// The server-owned store for files a client attaches to a structured chat.
//
// `<root>/<upload id>/<original file name>`: one directory per upload keeps the user's file name
// intact (agents read meaning into it) without two uploads colliding. Bytes land in a hidden part
// file and are renamed into place on commit, so a stored name is always complete. Which chats hold
// an upload is recorded by the message that names it (`agent-session-attachment-claims.ts`).

import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
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
} from '../../runtime/runtime-file-commands-mobile-file-list-limit'
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
  /** Whether this host holds the chat: an upload for any other chat is refused at its start. */
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

  /** Upload ids whose bytes are still arriving; the sweep leaves their directories alone. */
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
    // In flight until the rename lands, so the sweep never takes a slow upload's part file.
    upload.writing = true
    try {
      if (upload.receivedLength !== upload.expectedLength) {
        throw new Error('Attachment upload is incomplete')
      }
      const finalPath = join(upload.uploadDir, upload.name)
      // An antivirus or indexer briefly holding the part file on Windows must not lose the upload.
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

  /**
   * A stored image's bytes, for a client that shows it. Anything outside the store is refused, and
   * the read is protected and bounded: `maxContentBytes` is the reply's budget on a remote
   * connection, and an image over it is refused as too large rather than sent.
   */
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
      // One answer for everything else, so a read says nothing about the server's other files.
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
    // Another client's upload reads as absent, not as forbidden.
    if (upload.callerKey !== callerKey) {
      throw new Error(NOT_FOUND)
    }
    return upload
  }
}

export async function removeQuietly(path: string): Promise<void> {
  // Cleanup is best effort: a file that will not go is retried by the next sweep.
  await rm(path, { recursive: true, force: true }).catch(() => {})
}
