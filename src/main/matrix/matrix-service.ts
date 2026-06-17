import type { GlobalSettings } from '../../shared/types'
import { OrcaMatrixClient } from './client'
import { classifyMatrixError } from './matrix-event-format'
import {
  CredentialDecryptionError,
  clearMatrixToken,
  hasMatrixToken,
  readMatrixToken,
  storeMatrixToken
} from './matrix-credential-store'
import type {
  InboundMatrixMessage,
  MatrixConfig,
  MatrixConnectionStatus,
  MatrixViewer,
  OutboundResult
} from './types'

type InboundListener = (message: InboundMatrixMessage) => void

// Singleton owning the single OrcaMatrixClient lifecycle. This is the public
// surface the IPC layer, system-message forwarding, and inbound routing import —
// keep it stable. The client itself is replaced wholesale on config/token change
// so callers never hold a stale reference.
class MatrixService {
  private client: OrcaMatrixClient | null = null
  private activeConfig: MatrixConfig | null = null
  // The config last seen from settings, cached regardless of token presence so a
  // first-time connect() (token arrives before any client has started, hence
  // activeConfig is still null) can start against it.
  private desiredConfig: MatrixConfig | null = null
  private enabled = false
  private lastError: string | null = null
  private viewer: MatrixViewer | null = null
  private readonly listeners = new Set<InboundListener>()
  // Why: serialize start/stop so an overlapping configure()/connect() can't race
  // two clients onto the same account.
  private pending: Promise<void> = Promise.resolve()

  private configFromSettings(settings: GlobalSettings): MatrixConfig | null {
    const homeserver = settings.matrixHomeserver?.trim() ?? ''
    const userId = settings.matrixUserId?.trim() ?? ''
    const roomId = settings.matrixRoomId?.trim() ?? ''
    if (!homeserver || !userId || !roomId) {
      return null
    }
    return { homeserver, userId, roomId }
  }

  private configsEqual(a: MatrixConfig | null, b: MatrixConfig | null): boolean {
    if (a === null || b === null) {
      return a === b
    }
    return a.homeserver === b.homeserver && a.userId === b.userId && a.roomId === b.roomId
  }

  private dispatchInbound(message: InboundMatrixMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message)
      } catch (error) {
        // Why: one bad listener must not starve the others. Loud-log with the
        // classified reason; routing failures surface in-band where they happen.
        const classified = classifyMatrixError(error)
        console.error(
          `[matrix] inbound listener failed (${classified.type}): ${classified.message}`
        )
      }
    }
  }

  // Serializes lifecycle mutations through `pending` so concurrent callers queue
  // instead of racing two clients.
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.pending.then(task, task)
    // Swallow rejection on the chain itself (each task records its own error)
    // so a failed task doesn't poison the queue for the next caller.
    this.pending = run.catch(() => {})
    return run
  }

  private async startClient(config: MatrixConfig): Promise<void> {
    let token: string | null
    try {
      token = readMatrixToken()
    } catch (error) {
      this.lastError =
        error instanceof CredentialDecryptionError
          ? error.message
          : classifyMatrixError(error).message
      this.client = null
      this.activeConfig = null
      this.viewer = null
      return
    }
    if (!token) {
      this.lastError = 'No Matrix access token stored.'
      this.client = null
      this.activeConfig = null
      this.viewer = null
      return
    }

    const client = new OrcaMatrixClient(config, token)
    try {
      await client.start((message) => this.dispatchInbound(message))
      this.client = client
      this.activeConfig = config
      this.lastError = null
      try {
        this.viewer = await client.getViewer()
      } catch {
        // Viewer is best-effort; a running client without resolved profile still
        // counts as connected. The next getStatus refreshes it.
        this.viewer = null
      }
    } catch (error) {
      this.lastError = classifyMatrixError(error).message
      this.client = null
      this.activeConfig = null
      this.viewer = null
      await client.stop()
    }
  }

  private async stopClient(): Promise<void> {
    const client = this.client
    this.client = null
    this.activeConfig = null
    this.viewer = null
    if (client) {
      await client.stop()
    }
  }

  // Idempotent reconciliation against settings. Starts/stops/restarts the client
  // to match matrixEnabled + config + token presence. Safe to call repeatedly.
  configure(settings: GlobalSettings): void {
    const enabled = settings.matrixEnabled === true
    const config = this.configFromSettings(settings)
    this.enabled = enabled
    this.desiredConfig = config

    void this.enqueue(async () => {
      if (!enabled || !config || !hasMatrixToken()) {
        if (this.client) {
          await this.stopClient()
        }
        if (!enabled) {
          this.lastError = null
        } else if (!config) {
          this.lastError = 'Matrix homeserver, user id, and room id are required.'
        } else if (!hasMatrixToken()) {
          this.lastError = 'No Matrix access token stored.'
        }
        return
      }

      if (this.client && this.configsEqual(this.activeConfig, config)) {
        return
      }

      if (this.client) {
        await this.stopClient()
      }
      await this.startClient(config)
    })
  }

  // Stores the token then (re)starts against the last-known config. Returns the
  // outcome so the renderer can show success/failure in-band.
  async connect(token: string): Promise<{ ok: boolean; error?: string }> {
    try {
      storeMatrixToken(token)
    } catch (error) {
      // Loud but in-band: e.g. the keychain is unavailable. Surface it to the
      // renderer instead of rejecting the IPC call.
      return { ok: false, error: classifyMatrixError(error).message }
    }
    const config = this.desiredConfig
    if (!this.enabled || !config) {
      // No usable config yet — store the token and let a later configure() start.
      return {
        ok: false,
        error: 'Matrix is disabled or not configured (homeserver, user id, room id).'
      }
    }
    await this.enqueue(async () => {
      if (this.client) {
        await this.stopClient()
      }
      await this.startClient(config)
    })
    if (this.client) {
      return { ok: true }
    }
    return { ok: false, error: this.lastError ?? 'Failed to start Matrix client.' }
  }

  async disconnect(): Promise<void> {
    await this.enqueue(async () => {
      await this.stopClient()
      clearMatrixToken()
      this.lastError = null
    })
  }

  async getStatus(): Promise<MatrixConnectionStatus> {
    // Why: configure() reconciles the client asynchronously through the pending
    // queue. Awaiting it here means a status read always reflects the latest
    // requested lifecycle state rather than a half-applied transition.
    await this.pending
    const running = this.client?.isRunning() === true
    // Why: refresh the viewer lazily when running but unresolved, without
    // decrypting the token (that already happened at start) on every poll.
    if (running && !this.viewer && this.client) {
      try {
        this.viewer = await this.client.getViewer()
        // A successful refresh clears a stale transient error so a running client
        // doesn't stay pinned to ok:false after a one-off whoami hiccup.
        this.lastError = null
      } catch (error) {
        this.lastError = classifyMatrixError(error).message
      }
    }
    return {
      ok: running && this.lastError === null,
      enabled: this.enabled,
      running,
      ...(this.viewer ? { viewer: this.viewer } : {}),
      ...(this.activeConfig ? { roomId: this.activeConfig.roomId } : {}),
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  async sendToRoom(
    body: string,
    opts?: { roomId?: string; inReplyTo?: string; html?: string }
  ): Promise<OutboundResult> {
    // Why: a send issued right after configure() must wait for the requested
    // start to land rather than failing on a not-yet-assigned client.
    await this.pending
    const client = this.client
    if (!client) {
      return { ok: false, error: this.lastError ?? 'Matrix client is not running' }
    }
    return client.sendMessage(body, opts)
  }

  // Posts an emoji reaction (annotation) on an existing room event — used to
  // acknowledge receipt of an inbound operator message.
  async sendReaction(targetEventId: string, emoji: string): Promise<OutboundResult> {
    await this.pending
    const client = this.client
    if (!client) {
      return { ok: false, error: this.lastError ?? 'Matrix client is not running' }
    }
    return client.sendReaction(targetEventId, emoji)
  }

  // Registers an inbound listener. Returns an unsubscribe function. Listeners are
  // fanned out to for every inbound room message.
  onInbound(listener: InboundListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

let singleton: MatrixService | null = null

export function getMatrixService(): MatrixService {
  if (!singleton) {
    singleton = new MatrixService()
  }
  return singleton
}

export type { MatrixService }
