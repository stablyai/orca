import { app } from 'electron'
import type {
  ToknConnectResult,
  ToknSyncErrorCode,
  ToknSyncStatus,
  ToknUploadPreview
} from '../../shared/tokn-sync-status'
import type { ClaudeUsageDailyAggregate } from '../claude-usage/types'
import type { CodexUsageDailyAggregate } from '../codex-usage/types'
import { beginLoopbackPkceFlow } from '../oauth-loopback/loopback-pkce-flow'
import {
  clearToknAccount,
  loadToknAccountRecord,
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
import { buildToknSyncRows } from './tokn-sync-rows'

// tokn's board refreshes hourly; uploading more often only costs both sides work.
const AUTO_SYNC_INTERVAL_MS = 60 * 60_000
// Let startup scans and window restore settle before the first upload.
const STARTUP_SYNC_DELAY_MS = 2 * 60_000
// tokn answers 429 to a second upload from one device this soon, and it would carry the same totals.
const TOKN_MIN_SYNC_GAP_MS = 10_000

type ToknUsageSource<Aggregate> = {
  whenLoaded(): Promise<void>
  getScanState(): { enabled: boolean }
  refresh(force?: boolean): Promise<unknown>
  getDailyAggregates(): readonly Aggregate[]
}

export type ToknUsageSources = {
  claude: ToknUsageSource<ClaudeUsageDailyAggregate>
  codex: ToknUsageSource<CodexUsageDailyAggregate>
}

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
  private timer: ReturnType<typeof setTimeout> | null = null
  // tokn revoked this computer from its account page; say so until the next connect.
  private signedOutRemotely = false

  constructor(private readonly usage: ToknUsageSources) {
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
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  async getStatus(): Promise<ToknSyncStatus> {
    await this.loaded
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
      tracking: {
        claude: this.usage.claude.getScanState().enabled,
        codex: this.usage.codex.getScanState().enabled
      }
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
        return { outcome: 'cancelled', status: await this.getStatus() }
      }
      const previousToken = this.record ? readToknAccessToken() : null
      const record: ToknAccountRecord = {
        origin,
        handle: grant.handle,
        profileUrl: grant.profileUrl,
        lastSyncAt: null,
        lastSyncError: null,
        lastSyncErrorDetail: null,
        lastSyncAccepted: null,
        lastSyncRejected: null
      }
      saveToknAccount(grant.accessToken, record)
      this.record = record
      this.signedOutRemotely = false
      if (previousToken && previousToken !== grant.accessToken) {
        void revokeToknToken(origin, previousToken).catch(() => {})
      }
      this.connectAbort = null
      void this.syncNow()
      return { outcome: 'connected', status: await this.getStatus() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const outcome = authOutcome(message)
      if (this.connectAbort === abort) {
        this.connectAbort = null
      }
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
    await clearToknAccount()
    if (token) {
      await revokeToknToken(origin, token).catch((error) => {
        console.warn(
          '[tokn] Could not revoke the token on tokn; revoke it from your account',
          error
        )
      })
    }
    return this.getStatus()
  }

  async previewUpload(): Promise<ToknUploadPreview> {
    return {
      endpoint: `${getToknOrigin()}/api/cli/sync`,
      body: await this.buildUploadBody()
    }
  }

  async syncNow(): Promise<ToknSyncStatus> {
    await this.loaded
    if (!this.syncPromise) {
      this.syncPromise = this.runSync().finally(() => {
        this.syncPromise = null
        if (this.record) {
          this.schedule(AUTO_SYNC_INTERVAL_MS)
        }
      })
    }
    await this.syncPromise
    return this.getStatus()
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

  private async buildUploadBody(): Promise<ToknUploadPreview['body']> {
    const [claude, codex] = await Promise.all([
      this.readAggregates(this.usage.claude),
      this.readAggregates(this.usage.codex)
    ])
    return {
      rows: buildToknSyncRows({ claude, codex }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      scannedAt: new Date().toISOString(),
      cliVersion: app.getVersion()
    }
  }

  private async readAggregates<Aggregate>(
    source: ToknUsageSource<Aggregate>
  ): Promise<readonly Aggregate[]> {
    await source.whenLoaded()
    if (!source.getScanState().enabled) {
      return []
    }
    // Reuses a scan from the last few minutes; otherwise rescans the local logs.
    await source.refresh(false)
    return source.getDailyAggregates()
  }

  private async runSync(): Promise<void> {
    const record = this.record
    if (!record) {
      return
    }
    if (!this.usage.claude.getScanState().enabled && !this.usage.codex.getScanState().enabled) {
      this.saveRecord(record, {
        ...record,
        lastSyncError: 'tracking-off',
        lastSyncErrorDetail: null
      })
      return
    }
    const token = readToknAccessToken()
    if (!token) {
      this.saveRecord(record, { ...record, lastSyncError: 'signed-out', lastSyncErrorDetail: null })
      return
    }
    if (
      record.lastSyncError === null &&
      record.lastSyncAt !== null &&
      Date.now() - record.lastSyncAt < TOKN_MIN_SYNC_GAP_MS
    ) {
      return
    }
    let next: ToknAccountRecord
    try {
      const reply = await uploadToknUsage(record.origin, token, await this.buildUploadBody())
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
      if (error instanceof ToknRequestError && error.code === 'signed-out') {
        // The token was revoked on tokn; keeping it would fail every hour.
        if (this.record === record) {
          this.record = null
          this.signedOutRemotely = true
          await clearToknAccount()
        }
        return
      }
      const code: ToknSyncErrorCode = error instanceof ToknRequestError ? error.code : 'server'
      const detail = error instanceof ToknRequestError ? error.detail : null
      next = { ...record, lastSyncError: code, lastSyncErrorDetail: detail }
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
