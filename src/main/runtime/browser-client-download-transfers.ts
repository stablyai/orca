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

// Remote downloads need an in-workspace home reachable through containment-checked transfers.
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
  /** Set synchronously before queued cleanup. */
  canceled: boolean
  operations: Promise<void>
  /** Armed only while idle so slow chunks never look stranded. */
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

// UUIDs are never reused; retain a bounded settled trail to reject late resurrection.
const MIN_SETTLED_TRANSFER_TRAIL = 64

// Lost aborts must not strand transfers and exhaust shared slots.
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

  // Page close/fencing must remove partial remote files.
  /** Omitting the generation releases every generation of the page. */
  async releasePage(browserPageId: string, pageHostGeneration?: number): Promise<void> {
    const owned = [...this.sessions.values()].filter(
      (session) =>
        session.browserPageId === browserPageId &&
        (pageHostGeneration === undefined || session.pageHostGeneration === pageHostGeneration)
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
    // Cancellation during write leaves cleanup queued; stop accounting/commit now.
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
        // Both backends commit exclusively; retry name races without losing transferred bytes.
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
      // Failed partial-file removal must not fail the cleanup command.
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

// Local EEXIST becomes message-only text across the SSH RPC boundary.
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
  return `${browserPageId}\u0000${transferId}`
}
