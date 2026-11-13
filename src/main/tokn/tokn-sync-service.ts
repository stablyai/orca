import { app } from 'electron'
import type {
  ToknConnectResult,
  ToknSyncStatus,
  ToknUploadPreview
} from '../../shared/tokn-sync-status'
import { beginLoopbackPkceFlow } from '../oauth-loopback/loopback-pkce-flow'
import {
  clearToknAccount,
  loadToknAccountRecord,
  newToknAccountRecord,
  readToknAccessToken,
  saveToknAccount,
  saveToknAccountRecord,
  type ToknAccountRecord
} from './tokn-account-store'
import {
  exchangeToknAuthorizationCode,
  revokeToknToken,
  ToknRequestError,
  uploadToknUsage
} from './tokn-api-client'
import { getToknOrigin, toknSignInFlowConfig } from './tokn-service-config'
import { buildToknUploadBody, type ToknUsageReader } from './tokn-upload-body'

// tokn's board refreshes hourly; uploading more often only costs both sides work.
const AUTO_SYNC_INTERVAL_MS = 60 * 60_000
// Let startup scans and window restore settle before the first upload.
const STARTUP_SYNC_DELAY_MS = 2 * 60_000
// tokn answers 429 to a second upload from one device this soon, and it would carry the same totals.
const TOKN_MIN_SYNC_GAP_MS = 10_000

function authOutcome(message: string): ToknConnectResult['outcome'] {
  if (message === 'tokn_auth_timeout') {
    return 'timed-out'
  }
  return message === 'tokn_auth_cancelled' || message === 'tokn_auth_denied'
    ? 'cancelled'
    : 'failed'
}

export class ToknSyncService {
  // This service is the only writer, so the saved record is read once and kept here.
  private record: ToknAccountRecord | null = null
  private readonly loaded: Promise<void>
  private connectAbort: AbortController | null = null
  private syncPromise: Promise<void> | null = null
  private syncAbort: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  // tokn revoked this computer from its account page; say so until the next connect.
  private signedOutRemotely = false

  constructor(private readonly usage: ToknUsageReader) {
    this.loaded = loadToknAccountRecord(getToknOrigin()).then(
      (record) => {
        this.record = record
      },
      (error) => console.warn('[tokn] Could not read the saved connection', error)
    )
  }

  start(): void {
    void this.loaded.then(() => {
      if (!this.record) {
        return
      }
      const last = this.record.lastSyncAt
      const dueIn = last ? last + AUTO_SYNC_INTERVAL_MS - Date.now() : 0
      this.schedule(Math.max(STARTUP_SYNC_DELAY_MS, dueIn))
    })
  }

  stop(): void {
    this.connectAbort?.abort()
    this.syncAbort?.abort()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async getStatus(): Promise<ToknSyncStatus> {
    const [tracking] = await Promise.all([
      // Unknown while the usage service restarts; never claim tracking is off without knowing.
      this.usage.readTracking().catch(() => ({ claude: true, codex: true })),
      this.loaded
    ])
    const record = this.record
    return {
      connected: record !== null,
      connecting: this.connectAbort !== null,
      syncing: this.syncPromise !== null,
      handle: record?.handle ?? null,
      profileUrl: record?.profileUrl ?? null,
      lastSyncAt: record?.lastSyncAt ?? null,
      lastSyncError: record?.lastSyncError ?? (this.signedOutRemotely ? 'signed-out' : null),
      lastSyncErrorDetail: record?.lastSyncErrorDetail ?? null,
      lastSyncAccepted: record?.lastSyncAccepted ?? null,
      lastSyncRejected: record?.lastSyncRejected ?? null,
      tracking
    }
  }

  async connect(): Promise<ToknConnectResult> {
    await this.loaded
    // A second click restarts sign-in instead of leaving two listeners open.
    this.connectAbort?.abort()
    const abort = new AbortController()
    this.connectAbort = abort
    const origin = getToknOrigin()
    try {
      const code = await beginLoopbackPkceFlow(toknSignInFlowConfig(origin), {
        signal: abort.signal
      })
      const grant = await exchangeToknAuthorizationCode(origin, code)
      if (abort.signal.aborted) {
        // Superseded after the browser answered; do not leave the new token live on tokn.
        void revokeToknToken(origin, grant.accessToken).catch(() => {})
        this.releaseConnect(abort)
        return { outcome: 'cancelled', status: await this.getStatus() }
      }
      const previousToken = this.record ? readToknAccessToken() : null
      const record = newToknAccountRecord(origin, grant.handle, grant.profileUrl)
      // An upload still carrying the replaced account's token must not land after this one takes over.
      this.syncAbort?.abort()
      try {
        await saveToknAccount(grant.accessToken, record)
      } catch (error) {
        // Never leave one account's token beside another's record; sign out of both instead.
        await this.discardAccounts(origin, [grant.accessToken, previousToken])
        throw error
      }
      if (abort.signal.aborted || this.connectAbort !== abort) {
        // Cancelled, disconnected or superseded during the save, which already replaced the old account.
        await this.discardAccounts(origin, [grant.accessToken, previousToken])
        this.releaseConnect(abort)
        return { outcome: 'cancelled', status: await this.getStatus() }
      }
      this.record = record
      this.signedOutRemotely = false
      if (previousToken && previousToken !== grant.accessToken) {
        void revokeToknToken(origin, previousToken).catch(() => {})
      }
      this.releaseConnect(abort)
      // A sync still running for the replaced account cannot upload for this one.
      void Promise.resolve(this.syncPromise).then(() => this.syncNow())
      return { outcome: 'connected', status: await this.getStatus() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const outcome = authOutcome(message)
      this.releaseConnect(abort)
      return {
        outcome,
        ...(outcome === 'failed' ? { error: message } : {}),
        status: await this.getStatus()
      }
    }
  }

  cancelConnect(): Promise<ToknSyncStatus> {
    this.connectAbort?.abort()
    this.connectAbort = null
    return this.getStatus()
  }

  async disconnect(): Promise<ToknSyncStatus> {
    await this.loaded
    const origin = getToknOrigin()
    const token = this.record ? readToknAccessToken() : null
    // Forget locally first so a failed revoke cannot keep this computer uploading.
    this.record = null
    this.signedOutRemotely = false
    this.stop()
    // Revoke even if a file survives: tokn then refuses that token after a restart too.
    await clearToknAccount().catch((error) => {
      console.warn('[tokn] Could not delete the saved connection', error)
    })
    const revoked =
      !token ||
      (await revokeToknToken(origin, token).then(
        () => true,
        (error) => {
          console.warn('[tokn] Could not revoke the token on tokn', error)
          return false
        }
      ))
    if (!revoked && (await loadToknAccountRecord(origin))) {
      // The next launch would load this connection with a live token; only the user can stop that now.
      throw new Error('tokn_disconnect_incomplete')
    }
    return this.getStatus()
  }

  async previewUpload(): Promise<ToknUploadPreview> {
    return {
      endpoint: `${getToknOrigin()}/api/cli/sync`,
      body: await buildToknUploadBody(this.usage, app.getVersion())
    }
  }

  syncNow(): Promise<ToknSyncStatus> {
    // Set synchronously so a status read right after this call already reports the sync.
    if (!this.syncPromise) {
      this.syncPromise = this.loaded
        .then(() => this.runSync())
        .finally(() => {
          this.syncPromise = null
          if (this.record) {
            this.schedule(AUTO_SYNC_INTERVAL_MS)
          }
        })
    }
    return this.syncPromise.then(() => this.getStatus())
  }

  /** Signs out of both accounts: by now the save has removed the previous one's record. */
  private async discardAccounts(origin: string, tokens: readonly (string | null)[]): Promise<void> {
    this.record = null
    await clearToknAccount().catch(() => {})
    for (const token of tokens) {
      if (token) {
        void revokeToknToken(origin, token).catch(() => {})
      }
    }
  }

  /** A newer connect() owns the field once it has replaced this attempt's controller. */
  private releaseConnect(abort: AbortController): void {
    if (this.connectAbort === abort) {
      this.connectAbort = null
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.syncNow()
    }, delayMs)
    this.timer.unref?.()
  }

  private async runSync(): Promise<void> {
    const record = this.record
    if (!record) {
      return
    }
    if (
      record.lastSyncError === null &&
      record.lastSyncAt !== null &&
      Date.now() - record.lastSyncAt < TOKN_MIN_SYNC_GAP_MS
    ) {
      return
    }
    const abort = new AbortController()
    this.syncAbort = abort
    let next: ToknAccountRecord
    try {
      const tracking = await this.usage.readTracking()
      if (!tracking.claude && !tracking.codex) {
        this.saveRecord(record, {
          ...record,
          lastSyncError: 'tracking-off',
          lastSyncErrorDetail: null
        })
        return
      }
      const body = await buildToknUploadBody(this.usage, app.getVersion())
      // Disconnecting while the logs were read withdraws consent for this upload.
      const token = this.record === record ? readToknAccessToken() : null
      if (!token) {
        this.saveRecord(record, {
          ...record,
          lastSyncError: 'signed-out',
          lastSyncErrorDetail: null
        })
        return
      }
      const reply = await uploadToknUsage(record.origin, token, body, abort.signal)
      next = {
        ...record,
        profileUrl: reply.profileUrl ?? record.profileUrl,
        lastSyncAt: Date.now(),
        lastSyncError: null,
        lastSyncErrorDetail: null,
        lastSyncAccepted: reply.accepted,
        lastSyncRejected: reply.rejected
      }
    } catch (error) {
      if (abort.signal.aborted) {
        // Disconnect or quit cancelled it; neither is a sync failure to report.
        return
      }
      if (!(error instanceof ToknRequestError)) {
        // Orca's usage service failed before tokn was reached; Stats shows why, so retry next hour.
        console.warn('[tokn] Could not read tracked usage', error)
        return
      }
      if (error.code === 'signed-out') {
        // The token was revoked on tokn; keeping it would fail every hour.
        if (this.record === record) {
          this.record = null
          this.signedOutRemotely = true
          await clearToknAccount().catch((error) => {
            console.warn('[tokn] Could not delete the revoked connection', error)
          })
        }
        return
      }
      next = { ...record, lastSyncError: error.code, lastSyncErrorDetail: error.detail }
    } finally {
      if (this.syncAbort === abort) {
        this.syncAbort = null
      }
    }
    this.saveRecord(record, next)
  }

  /** Skips the write when a disconnect or reconnect replaced `current` during the upload. */
  private saveRecord(current: ToknAccountRecord, next: ToknAccountRecord): void {
    if (this.record !== current) {
      return
    }
    this.record = next
    try {
      saveToknAccountRecord(next)
    } catch (error) {
      // The in-memory status stays right; a lost write only means an earlier sync next launch.
      console.warn('[tokn] Could not save sync status', error)
    }
  }
}
