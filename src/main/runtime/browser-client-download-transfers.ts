import {
  BROWSER_CLIENT_FILE_CHANNEL_MAX_ACTIVE_DOWNLOADS,
  BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES,
  decodeBrowserClientFileChannelChunk
} from '../../shared/browser-client-file-channel-protocol'
import {
  buildBrowserDownloadCollisionCandidate,
  MAX_BROWSER_DOWNLOAD_COLLISION_ATTEMPTS,
  normalizeBrowserDownloadFilename
} from '../../shared/browser-download-filename'

// Why: client-hosted downloads land in the remote workspace, not the desktop, so they need a
// stable in-workspace home that the containment-checked file transfer path can reach.
export const BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY = '.orca/browser-downloads'

export type BrowserClientDownloadTransferDependencies = {
  writeChunk(input: {
    workspaceId: string
    relativePath: string
    contentBase64: string
    append: boolean
  }): Promise<void>
  commit(input: {
    workspaceId: string
    tempRelativePath: string
    finalRelativePath: string
  }): Promise<void>
  remove(input: { workspaceId: string; relativePath: string }): Promise<void>
  exists(input: { workspaceId: string; relativePath: string }): Promise<boolean>
  ensureDirectory(input: { workspaceId: string; relativePath: string }): Promise<void>
}

type TransferSession = {
  key: string
  browserPageId: string
  pageHostGeneration: number
  workspaceId: string
  tempRelativePath: string
  bytesWritten: number
  /** Set the moment an abort or page release is requested, before its cleanup is queued. */
  canceled: boolean
  /** Serializes this transfer's writes, commits, and cleanup against each other. */
  operations: Promise<void>
  /** Armed only while the transfer is idle, so a slow chunk is never mistaken for a stranded one. */
  idleTimer: ReturnType<typeof setTimeout> | null
}

export type BrowserClientDownloadCommit = {
  workspaceRelativePath: string
}

export type BrowserClientDownloadChunk = {
  transferId: string
  browserPageId: string
  pageHostGeneration: number
  workspaceId: string
  filename: string
  contentBase64: string
  offset: number
  final: boolean
  platform: NodeJS.Platform
}

// Why: transfer ids are per-download UUIDs, so a settled id is never legitimately reused; keeping a
// bounded trail of them stops a late chunk from resurrecting a transfer the runtime already cleaned.
const MIN_SETTLED_TRANSFER_TRAIL = 64

// Why: the client's abort is lost exactly when it matters -- a transport blip rejects it silently --
// so a transfer nobody is feeding has to retire itself or stranded ones exhaust the shared slots.
export const BROWSER_CLIENT_DOWNLOAD_TRANSFER_IDLE_TIMEOUT_MS = 3 * 60_000

export class BrowserClientDownloadTransferStore {
  private readonly sessions = new Map<string, TransferSession>()
  private readonly settled = new Set<string>()
  private readonly maxSettledTrail: number

  constructor(
    private readonly dependencies: BrowserClientDownloadTransferDependencies,
    private readonly maxActiveTransfers = BROWSER_CLIENT_FILE_CHANNEL_MAX_ACTIVE_DOWNLOADS,
    private readonly idleTimeoutMs = BROWSER_CLIENT_DOWNLOAD_TRANSFER_IDLE_TIMEOUT_MS
  ) {
    this.maxSettledTrail = Math.max(this.maxActiveTransfers * 4, MIN_SETTLED_TRANSFER_TRAIL)
  }

  async accept(input: BrowserClientDownloadChunk): Promise<BrowserClientDownloadCommit | null> {
    const chunk = decodeBrowserClientFileChannelChunk(input.contentBase64)
    const session = this.requireSession(input)
    this.clearIdleTimer(session)
    try {
      return await this.serialize(session, () => this.write(session, input, chunk.byteLength))
    } finally {
      this.armIdleTimer(session)
    }
  }

  abort(input: { transferId: string; browserPageId: string }): Promise<boolean> {
    const session = this.sessions.get(sessionKey(input.browserPageId, input.transferId))
    if (!session) {
      return Promise.resolve(false)
    }
    session.canceled = true
    return this.serialize(session, () => this.release(session)).then(() => true)
  }

  // Why: page close and lease fencing must not leave half-written files in the remote workspace.
  async releasePage(browserPageId: string): Promise<void> {
    const owned = [...this.sessions.values()].filter(
      (session) => session.browserPageId === browserPageId
    )
    for (const session of owned) {
      session.canceled = true
    }
    await Promise.all(owned.map((session) => this.serialize(session, () => this.release(session))))
  }

  activeTransferCount(): number {
    return this.sessions.size
  }

  private armIdleTimer(session: TransferSession): void {
    if (session.idleTimer || this.sessions.get(session.key) !== session) {
      return
    }
    const timer = setTimeout(() => {
      void this.expire(session)
    }, this.idleTimeoutMs)
    timer.unref?.()
    session.idleTimer = timer
  }

  private clearIdleTimer(session: TransferSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
  }

  private async expire(session: TransferSession): Promise<void> {
    session.idleTimer = null
    if (this.sessions.get(session.key) !== session) {
      return
    }
    session.canceled = true
    await this.serialize(session, () => this.release(session)).catch(() => undefined)
  }

  /** Runs `operation` after every earlier operation on the same transfer has settled. */
  private serialize<T>(session: TransferSession, operation: () => Promise<T>): Promise<T> {
    const running = session.operations.then(operation, operation)
    session.operations = running.then(
      () => undefined,
      () => undefined
    )
    return running
  }

  private async write(
    session: TransferSession,
    input: BrowserClientDownloadChunk,
    byteLength: number
  ): Promise<BrowserClientDownloadCommit | null> {
    this.assertLive(session)
    if (input.offset !== session.bytesWritten) {
      await this.release(session)
      throw new Error('browser_client_download_transfer_out_of_order')
    }
    if (session.bytesWritten + byteLength > BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES) {
      await this.release(session)
      throw new Error('browser_client_download_transfer_too_large')
    }
    try {
      if (session.bytesWritten === 0) {
        await this.dependencies.ensureDirectory({
          workspaceId: session.workspaceId,
          relativePath: BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY
        })
        this.assertLive(session)
      }
      await this.dependencies.writeChunk({
        workspaceId: session.workspaceId,
        relativePath: session.tempRelativePath,
        contentBase64: input.contentBase64,
        append: session.bytesWritten > 0
      })
    } catch (error) {
      await this.release(session)
      throw error
    }
    // Why: cancellation during the write leaves the temp file for the queued release to remove; the
    // transfer must not keep accounting bytes or continue to a commit after that.
    this.assertLive(session)
    session.bytesWritten += byteLength
    if (!input.final) {
      return null
    }
    try {
      return await this.commit(session, input.filename, input.platform)
    } catch (error) {
      await this.release(session)
      throw error
    }
  }

  private assertLive(session: TransferSession): void {
    if (session.canceled || this.sessions.get(session.key) !== session) {
      throw new Error('browser_client_download_transfer_aborted')
    }
  }

  private requireSession(input: {
    transferId: string
    browserPageId: string
    pageHostGeneration: number
    workspaceId: string
    filename: string
    platform: NodeJS.Platform
  }): TransferSession {
    const key = sessionKey(input.browserPageId, input.transferId)
    const existing = this.sessions.get(key)
    if (existing) {
      if (
        existing.pageHostGeneration !== input.pageHostGeneration ||
        existing.workspaceId !== input.workspaceId
      ) {
        throw new Error('browser_client_download_transfer_stale')
      }
      return existing
    }
    if (this.settled.has(key)) {
      throw new Error('browser_client_download_transfer_settled')
    }
    if (this.sessions.size >= this.maxActiveTransfers) {
      throw new Error('browser_client_download_transfer_capacity')
    }
    const session: TransferSession = {
      key,
      browserPageId: input.browserPageId,
      pageHostGeneration: input.pageHostGeneration,
      workspaceId: input.workspaceId,
      tempRelativePath: `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/.incoming-${input.transferId}`,
      bytesWritten: 0,
      canceled: false,
      operations: Promise.resolve(),
      idleTimer: null
    }
    this.sessions.set(key, session)
    return session
  }

  private async commit(
    session: TransferSession,
    filename: string,
    platform: NodeJS.Platform
  ): Promise<BrowserClientDownloadCommit> {
    const safeFilename = normalizeBrowserDownloadFilename(filename, platform)
    for (let attempt = 0; attempt < MAX_BROWSER_DOWNLOAD_COLLISION_ATTEMPTS; attempt += 1) {
      const candidate = buildBrowserDownloadCollisionCandidate(safeFilename, attempt)
      const finalRelativePath = `${BROWSER_CLIENT_DOWNLOAD_WORKSPACE_DIRECTORY}/${candidate}`
      if (
        await this.dependencies.exists({
          workspaceId: session.workspaceId,
          relativePath: finalRelativePath
        })
      ) {
        continue
      }
      this.assertLive(session)
      try {
        await this.dependencies.commit({
          workspaceId: session.workspaceId,
          tempRelativePath: session.tempRelativePath,
          finalRelativePath
        })
      } catch (error) {
        // Why: both commit backends are exclusive, so a transfer that lost the name race between
        // `exists` and here must take the next candidate instead of losing its transferred bytes.
        if (!isDestinationExistsError(error)) {
          throw error
        }
        continue
      }
      this.settle(session)
      return { workspaceRelativePath: finalRelativePath }
    }
    throw new Error('browser_client_download_transfer_name_unavailable')
  }

  private async release(session: TransferSession): Promise<void> {
    const owned = this.sessions.get(session.key) === session
    this.settle(session)
    if (!owned) {
      return
    }
    try {
      await this.dependencies.remove({
        workspaceId: session.workspaceId,
        relativePath: session.tempRelativePath
      })
    } catch {
      // Why: a partial file that cannot be removed must not turn cleanup into a failed command.
    }
  }

  private settle(session: TransferSession): void {
    this.clearIdleTimer(session)
    if (this.sessions.get(session.key) === session) {
      this.sessions.delete(session.key)
    }
    this.settled.add(session.key)
    while (this.settled.size > this.maxSettledTrail) {
      const oldest = this.settled.values().next()
      if (oldest.done) {
        return
      }
      this.settled.delete(oldest.value)
    }
  }
}

// Why: the local backend rejects with an errno EEXIST, the SSH backend with the relay's re-thrown
// message, which crosses the RPC boundary as text only.
function isDestinationExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return (
    (error as NodeJS.ErrnoException).code === 'EEXIST' ||
    /\bEEXIST\b|already exists/i.test(error.message)
  )
}

function sessionKey(browserPageId: string, transferId: string): string {
  return `${browserPageId} ${transferId}`
}
