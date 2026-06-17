import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { MatrixClient, RustSdkCryptoStorageProvider, SimpleFsStorageProvider } from 'matrix-bot-sdk'
import type { RustSdkCryptoStoreType } from 'matrix-bot-sdk'
import { classifyMatrixError } from './matrix-event-format'
import type { InboundMatrixMessage, MatrixConfig, MatrixViewer, OutboundResult } from './types'

const HTML_FORMAT = 'org.matrix.custom.html'
// RustSdkCryptoStoreType.Sqlite from @matrix-org/matrix-sdk-crypto-nodejs. It is
// a const enum (value 0) that isolatedModules forbids importing by name; the
// rust-sdk only ships the sqlite store, so this is the single valid choice.
const RUST_CRYPTO_STORE_SQLITE = 0 as RustSdkCryptoStoreType

type InboundHandler = (message: InboundMatrixMessage) => void

// A raw decrypted Matrix m.room.message event as matrix-bot-sdk hands it to the
// 'room.message' listener. Encrypted rooms are already decrypted at this point.
type RawRoomEvent = {
  event_id?: string
  sender?: string
  origin_server_ts?: number
  content?: {
    msgtype?: string
    body?: unknown
    format?: string
    formatted_body?: unknown
    'm.relates_to'?: { 'm.in_reply_to'?: { event_id?: string } }
  }
}

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

// Why: the rust-sdk crypto store is a *directory* of sqlite db files; it must
// persist across restarts so the device's Olm/Megolm keys (and therefore its
// device identity) survive. This replaces the old in-memory crypto + reused
// device-id hack, which produced a server-side identity-key mismatch.
function getCryptoStoreDir(): string {
  return join(getOrcaDir(), 'matrix-crypto')
}

// Persistent sync token / filter state so resumed syncs don't re-scan history.
function getStateFile(): string {
  return join(getOrcaDir(), 'matrix-bot-state.json')
}

export class OrcaMatrixClient {
  private readonly config: MatrixConfig
  private readonly accessToken: string
  private client: MatrixClient | null = null
  private onInbound: InboundHandler | null = null
  private running = false
  private ownUserId: string | null = null

  constructor(config: MatrixConfig, accessToken: string) {
    this.config = config
    this.accessToken = accessToken
  }

  isRunning(): boolean {
    return this.running
  }

  // Constructs the bot client against a file-based crypto store, derives the
  // device/user identity from the access token (whoami), wires inbound
  // m.room.message events for the configured room, joins it, and starts syncing.
  // Throws a classified Error on failure — never silently no-ops.
  async start(onInbound: InboundHandler): Promise<void> {
    if (this.running) {
      return
    }
    this.onInbound = onInbound

    try {
      mkdirSync(getCryptoStoreDir(), { recursive: true })
      const storage = new SimpleFsStorageProvider(getStateFile())
      // Why: device_id/userId derive from the access token server-side; we keep
      // only the crypto store dir stable across restarts, never a minted id.
      // RustSdkCryptoStoreType.Sqlite is a const enum (== 0); isolatedModules
      // forbids referencing it, so pass the literal the rust-sdk expects.
      const crypto = new RustSdkCryptoStorageProvider(getCryptoStoreDir(), RUST_CRYPTO_STORE_SQLITE)
      const client = new MatrixClient(this.config.homeserver, this.accessToken, storage, crypto)
      this.client = client

      // Whoami: the relay's own user id, so we can drop our outbound echoes.
      this.ownUserId = await client.getUserId()

      // Prepare the rust OlmMachine. Passing the configured room lets it set up
      // megolm tracking for it; join is best-effort below if we aren't a member.
      await client.crypto.prepare([this.config.roomId])

      this.subscribeInbound(client)

      // Best-effort join: if we're already in the room this is a no-op; a failure
      // here must not block start — sync will still surface messages once joined.
      try {
        await client.joinRoom(this.config.roomId)
      } catch (error) {
        const classified = classifyMatrixError(error)
        console.error(
          `[matrix] joinRoom best-effort failed (${classified.type}): ${classified.message}`
        )
      }

      await client.start()
      this.running = true
    } catch (error) {
      // Loud: tear down a half-started client and rethrow a classified message
      // so the caller surfaces the failure in-band rather than logging it.
      await this.stop()
      const classified = classifyMatrixError(error)
      throw new Error(`Matrix start failed (${classified.type}): ${classified.message}`)
    }
  }

  private subscribeInbound(client: MatrixClient): void {
    // matrix-bot-sdk emits 'room.message' with the already-decrypted raw event
    // for encrypted rooms, so no manual decrypt step is needed here.
    client.on('room.message', (roomId: string, event: RawRoomEvent) => {
      if (roomId !== this.config.roomId) {
        return
      }
      this.handleRoomMessage(roomId, event)
    })
  }

  private handleRoomMessage(roomId: string, event: RawRoomEvent): void {
    try {
      const sender = event.sender
      // Ignore our own echoes — outbound messages come back through sync.
      if (!sender || sender === this.ownUserId) {
        return
      }
      const eventId = event.event_id
      if (!eventId) {
        return
      }
      const content = event.content ?? {}
      const body = typeof content.body === 'string' ? content.body : ''
      const html =
        content.format === HTML_FORMAT && typeof content.formatted_body === 'string'
          ? content.formatted_body
          : undefined
      const relatesTo = content['m.relates_to']
      const inReplyToEventId = relatesTo?.['m.in_reply_to']?.event_id

      const message: InboundMatrixMessage = {
        eventId,
        roomId,
        sender,
        body,
        ...(html ? { html } : {}),
        ts: typeof event.origin_server_ts === 'number' ? event.origin_server_ts : Date.now(),
        ...(inReplyToEventId ? { inReplyToEventId } : {})
      }
      this.onInbound?.(message)
    } catch (error) {
      // Loud: a parse failure on one event must not crash the sync loop, but it
      // also must not vanish — classify and log with enough context to act.
      const classified = classifyMatrixError(error)
      console.error(
        `[matrix] failed to handle inbound event (${classified.type}): ${classified.message}`
      )
    }
  }

  // Sends an m.room.message (m.text). When html is provided, also sets the
  // org.matrix.custom.html formatted body. Encrypted send is automatic once the
  // crypto store is prepared and the room is encrypted.
  async sendMessage(
    body: string,
    opts?: { roomId?: string; inReplyTo?: string; html?: string }
  ): Promise<OutboundResult> {
    const client = this.client
    if (!client || !this.running) {
      return { ok: false, error: 'Matrix client is not running' }
    }
    const roomId = opts?.roomId ?? this.config.roomId
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body,
      ...(opts?.html ? { format: HTML_FORMAT, formatted_body: opts.html } : {}),
      ...(opts?.inReplyTo
        ? { 'm.relates_to': { 'm.in_reply_to': { event_id: opts.inReplyTo } } }
        : {})
    }
    try {
      const eventId = await client.sendMessage(roomId, content)
      return { ok: true, eventId }
    } catch (error) {
      const classified = classifyMatrixError(error)
      return { ok: false, error: `${classified.type}: ${classified.message}` }
    }
  }

  // Posts an emoji reaction (m.reaction annotation) on an existing event. Used to
  // acknowledge receipt of an inbound message. Reactions are cleartext relations
  // (not encrypted), so the operator sees them regardless of E2E state.
  async sendReaction(
    targetEventId: string,
    emoji: string,
    roomId?: string
  ): Promise<OutboundResult> {
    const client = this.client
    if (!client || !this.running) {
      return { ok: false, error: 'Matrix client is not running' }
    }
    try {
      const eventId = await client.unstableApis.addReactionToEvent(
        roomId ?? this.config.roomId,
        targetEventId,
        emoji
      )
      return { ok: true, eventId }
    } catch (error) {
      const classified = classifyMatrixError(error)
      return { ok: false, error: `${classified.type}: ${classified.message}` }
    }
  }

  // Resolves the logged-in viewer (user id + display name). Returns null when the
  // client is not constructed; throws a classified Error on a network/auth
  // failure so the caller can surface it rather than seeing a silent null.
  async getViewer(): Promise<MatrixViewer | null> {
    const client = this.client
    if (!client) {
      return null
    }
    try {
      const userId = await client.getUserId()
      let displayName: string | undefined
      try {
        const profile = await client.getUserProfile(userId)
        displayName = typeof profile?.displayname === 'string' ? profile.displayname : undefined
      } catch {
        // Profile is best-effort metadata; absence must not fail the viewer read.
        displayName = undefined
      }
      return {
        userId,
        ...(displayName ? { displayName } : {}),
        homeserver: this.config.homeserver
      }
    } catch (error) {
      const classified = classifyMatrixError(error)
      throw new Error(`Matrix whoami failed (${classified.type}): ${classified.message}`)
    }
  }

  async stop(): Promise<void> {
    const client = this.client
    this.running = false
    if (client) {
      try {
        client.removeAllListeners('room.message')
        client.stop()
      } catch {
        // Best-effort teardown — stop must not throw.
      }
    }
    this.client = null
    this.onInbound = null
    this.ownUserId = null
  }
}
