// Phone files for terminal-backed chats stream to disk, so a large file never sits in memory.

import { appendFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ChunkedUploadRegistry,
  nextChunkedUploadLength
} from '../native-chat/agent-session-attachments/chunked-upload-registry'
import { shellInertFileName } from '../window/clipboard/clipboard-image-temp-file'

const UPLOAD_MAX_CONCURRENT = 8
const UPLOAD_IDLE_TTL_MS = 5 * 60 * 1000
const NOT_FOUND = 'Terminal file upload was not found'
const PART_FILE = '.part'
const PASTE_DIR_PREFIX = 'orca-paste-'
// The agent reads a sent file from its @path, in that turn or a later one of the same chat. Nothing
// tells the host when the chat is done with it, so committed folders are removed by age instead.
const COMMITTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000
const ABORTED = 'Terminal file upload was aborted'

type InFlightUpload = {
  callerKey: string
  uploadDir: string
  fileName: string
  expectedLength: number
  receivedLength: number
  writing: boolean
  /** Set by an abort that arrived mid-write; the writer removes the folder once its write settles. */
  aborted: boolean
}

async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => {})
}

export class TerminalFileUploadStore {
  private readonly uploads = new ChunkedUploadRegistry<InFlightUpload>({
    maxConcurrent: UPLOAD_MAX_CONCURRENT,
    ttlMs: UPLOAD_IDLE_TTL_MS,
    tooManyMessage: 'Too many terminal file uploads are in progress',
    notFoundMessage: NOT_FOUND,
    onExpire: (upload) => void removeQuietly(upload.uploadDir)
  })

  private lastSweepAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly tempRoot: () => string,
    private readonly now: () => number = Date.now
  ) {}

  async start(args: {
    callerKey: string
    name: string
    byteLength: number
  }): Promise<{ uploadId: string }> {
    const fileName = shellInertFileName(args.name)
    const root = this.tempRoot()
    if (this.now() - this.lastSweepAt >= SWEEP_INTERVAL_MS) {
      this.lastSweepAt = this.now()
      void this.removeExpiredCommittedUploads()
    }
    const uploadId = this.uploads.create((id) => ({
      callerKey: args.callerKey,
      uploadDir: join(root, `${PASTE_DIR_PREFIX}${id}`),
      fileName,
      expectedLength: args.byteLength,
      receivedLength: 0,
      writing: false,
      aborted: false
    }))
    const { uploadDir } = this.uploads.require(uploadId)
    try {
      // Owner-only: the OS temp folder can be shared with other local users.
      await mkdir(uploadDir, { recursive: true, mode: 0o700 })
      await writeFile(join(uploadDir, PART_FILE), '', { flag: 'wx', mode: 0o600 })
    } catch (error) {
      this.uploads.delete(uploadId)
      await removeQuietly(uploadDir)
      throw error
    }
    return { uploadId }
  }

  async append(args: {
    callerKey: string
    uploadId: string
    offset: number
    contentBase64: string
  }): Promise<{ receivedLength: number }> {
    const upload = this.requireOwned(args.uploadId, args.callerKey)
    if (upload.writing) {
      throw new Error('Terminal file chunk is already being written')
    }
    const bytes = Buffer.from(args.contentBase64, 'base64')
    const nextLength = nextChunkedUploadLength(upload, args.offset, bytes.byteLength, {
      outOfOrder: 'Terminal file chunk offset is out of order',
      exceeded: 'Terminal file upload exceeded its declared size'
    })
    // A fresh idle window before the write, so expiry cannot remove the folder under it.
    this.uploads.touch(args.uploadId)
    upload.writing = true
    try {
      await appendFile(join(upload.uploadDir, PART_FILE), bytes)
      if (upload.aborted) {
        throw new Error(ABORTED)
      }
      upload.receivedLength = nextLength
    } catch (error) {
      // Part of the chunk may be on disk; a retry at the same offset must not commit it.
      this.uploads.delete(args.uploadId)
      await removeQuietly(upload.uploadDir)
      throw error
    } finally {
      upload.writing = false
    }
    this.uploads.touch(args.uploadId)
    return { receivedLength: upload.receivedLength }
  }

  async commit(args: {
    callerKey: string
    uploadId: string
  }): Promise<{ path: string; name: string; byteLength: number }> {
    const upload = this.requireOwned(args.uploadId, args.callerKey)
    if (upload.writing) {
      throw new Error('Terminal file chunk is still being written')
    }
    // A fresh idle window outlasts the rename, so expiry cannot delete the folder mid-commit;
    // `writing` refuses an append that arrives while the commit runs.
    this.uploads.touch(args.uploadId)
    upload.writing = true
    try {
      if (upload.receivedLength !== upload.expectedLength) {
        throw new Error('Terminal file upload is incomplete')
      }
      const path = join(upload.uploadDir, upload.fileName)
      await rename(join(upload.uploadDir, PART_FILE), path)
      if (upload.aborted) {
        throw new Error(ABORTED)
      }
      return { path, name: upload.fileName, byteLength: upload.receivedLength }
    } catch (error) {
      await removeQuietly(upload.uploadDir)
      throw error
    } finally {
      this.uploads.delete(args.uploadId)
    }
  }

  async abort(args: { callerKey: string; uploadId: string }): Promise<{ aborted: true }> {
    const upload = this.uploads.peek(args.uploadId)
    if (upload) {
      if (upload.callerKey !== args.callerKey) {
        throw new Error(NOT_FOUND)
      }
      this.uploads.delete(args.uploadId)
      if (upload.writing) {
        // Removing the folder now could race a commit's rename; the writer sees the flag and removes it.
        upload.aborted = true
      } else {
        await removeQuietly(upload.uploadDir)
      }
    }
    return { aborted: true }
  }

  /** Removes committed upload folders older than the retention; runs at most hourly from `start`. */
  async removeExpiredCommittedUploads(): Promise<void> {
    const root = this.tempRoot()
    const names = await readdir(root).catch(() => [])
    const cutoff = this.now() - COMMITTED_RETENTION_MS
    await Promise.all(
      names
        .filter((name) => name.startsWith(PASTE_DIR_PREFIX))
        .map(async (name) => {
          const dir = join(root, name)
          const info = await stat(dir).catch(() => null)
          if (info?.isDirectory() && info.mtimeMs < cutoff) {
            await removeQuietly(dir)
          }
        })
    )
  }

  private requireOwned(uploadId: string, callerKey: string): InFlightUpload {
    const upload = this.uploads.require(uploadId)
    if (upload.callerKey !== callerKey) {
      throw new Error(NOT_FOUND)
    }
    return upload
  }
}
