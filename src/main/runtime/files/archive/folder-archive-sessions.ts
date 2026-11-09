import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  FileArchiveReadResult,
  FileArchiveStartResult
} from '../../../../shared/rpc-contract/files-archive-params'
import { planFolderArchive } from './folder-archive-walk'
import { FolderArchiveZipStream } from './folder-archive-zip-stream'

// A lost cancel (closed laptop, dropped socket) must not pin host memory or file handles.
export const FOLDER_ARCHIVE_IDLE_TIMEOUT_MS = 2 * 60_000
const MAX_ACTIVE_ARCHIVES = 4

type ArchiveSession = {
  id: string
  /** Only the connection that started an archive may read or cancel it. */
  ownerKey: string
  stream: FolderArchiveZipStream
  reading: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
}

export class FolderArchiveSessions {
  private readonly sessions = new Map<string, ArchiveSession>()

  constructor(
    private readonly idleTimeoutMs = FOLDER_ARCHIVE_IDLE_TIMEOUT_MS,
    private readonly maxActive = MAX_ACTIVE_ARCHIVES
  ) {}

  /** `folderPath` must already be confined to an allowed workspace root by the caller. */
  async start(input: {
    folderPath: string
    ownerKey: string
    excludeDefaultDirs: boolean
    signal?: AbortSignal
  }): Promise<FileArchiveStartResult> {
    if (this.sessions.size >= this.maxActive) {
      throw new Error('archive_busy')
    }
    const rootName = sanitizeArchiveRootName(basename(await realpath(input.folderPath)))
    const plan = await planFolderArchive(input.folderPath, rootName, {
      excludeDefaultDirs: input.excludeDefaultDirs,
      ...(input.signal ? { signal: input.signal } : {})
    })
    // Re-check after the walk: concurrent starts may have filled the slots meanwhile.
    if (this.sessions.size >= this.maxActive) {
      throw new Error('archive_busy')
    }
    const session: ArchiveSession = {
      id: randomUUID(),
      ownerKey: input.ownerKey,
      stream: new FolderArchiveZipStream(plan.entries),
      reading: false,
      idleTimer: null
    }
    this.sessions.set(session.id, session)
    this.armIdleTimer(session)
    return {
      archiveId: session.id,
      suggestedName: `${rootName}.zip`,
      fileCount: plan.fileCount,
      directoryCount: plan.directoryCount,
      totalBytes: plan.totalBytes,
      excludedDirCount: plan.excludedDirCount
    }
  }

  async read(input: {
    archiveId: string
    ownerKey: string
    maxBytes: number
  }): Promise<FileArchiveReadResult> {
    const session = this.requireSession(input.archiveId, input.ownerKey)
    if (session.reading) {
      throw new Error('archive_busy')
    }
    session.reading = true
    this.clearIdleTimer(session)
    try {
      const page = await session.stream.read(input.maxBytes)
      if (page.eof) {
        this.release(session)
      }
      return {
        contentBase64: page.bytes.toString('base64'),
        bytesRead: page.bytes.byteLength,
        eof: page.eof,
        processedBytes: session.stream.processedBytes,
        skippedCount: session.stream.skippedCount
      }
    } catch (error) {
      this.release(session)
      throw error
    } finally {
      session.reading = false
      if (this.sessions.get(session.id) === session) {
        this.armIdleTimer(session)
      }
    }
  }

  cancel(input: { archiveId: string; ownerKey: string }): boolean {
    const session = this.sessions.get(input.archiveId)
    if (!session || session.ownerKey !== input.ownerKey) {
      return false
    }
    this.release(session)
    return true
  }

  activeCount(): number {
    return this.sessions.size
  }

  private requireSession(archiveId: string, ownerKey: string): ArchiveSession {
    const session = this.sessions.get(archiveId)
    // Another connection's archive looks the same as a missing one.
    if (!session || session.ownerKey !== ownerKey) {
      throw new Error('archive_not_found')
    }
    return session
  }

  private release(session: ArchiveSession): void {
    this.clearIdleTimer(session)
    if (this.sessions.get(session.id) === session) {
      this.sessions.delete(session.id)
    }
    session.stream.cancel()
  }

  private armIdleTimer(session: ArchiveSession): void {
    this.clearIdleTimer(session)
    session.idleTimer = setTimeout(() => this.release(session), this.idleTimeoutMs)
    session.idleTimer.unref?.()
  }

  private clearIdleTimer(session: ArchiveSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
  }
}

function sanitizeArchiveRootName(name: string): string {
  // A filesystem root has no basename; zip readers choke on separators or control characters here.
  // oxlint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f/\\]/g, '_').trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'folder' : cleaned
}

const sessionsByRuntime = new WeakMap<object, FolderArchiveSessions>()

export function getFolderArchiveSessions(runtime: object): FolderArchiveSessions {
  let sessions = sessionsByRuntime.get(runtime)
  if (!sessions) {
    sessions = new FolderArchiveSessions()
    sessionsByRuntime.set(runtime, sessions)
  }
  return sessions
}
