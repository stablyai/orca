import { randomBytes } from 'node:crypto'
import {
  LOCAL_COMMAND_APPROVAL_WINDOW_MS,
  LOCAL_COMMAND_DEFAULT_TIMEOUT_SEC,
  LOCAL_COMMAND_ERRORS,
  LOCAL_COMMAND_MAX_PENDING,
  LOCAL_COMMAND_MAX_PER_HOUR,
  LOCAL_COMMAND_RESULT_GRACE_MS,
  type LocalCommandDeclineReason,
  type LocalCommandRequestedEvent,
  type LocalCommandRequestResult,
  type LocalCommandRunResult,
  type LocalCommandSettleParams,
  type LocalCommandSettleResult,
  type LocalCommandStatus,
  type LocalCommandStatusResult,
  type LocalCommandStreamEvent
} from '../../../shared/local-commands/local-command-contract'

const HOUR_MS = 60 * 60_000
/** Settled records stay readable this long so the agent's poll sees the outcome. */
const RECORD_RETENTION_MS = HOUR_MS

export class LocalCommandError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'LocalCommandError'
  }
}

type LocalCommandRecord = {
  requestId: string
  command: string
  cwd: string | null
  timeoutSec: number
  reason: string | null
  agent: string | null
  requestedAt: number
  expiresAt: number
  status: LocalCommandStatus
  /** The desktop that started it; only it may report the result. */
  runningDeviceId: string | null
  runDeadline: number
  /** Desktops that declined without a person's answer; settles once every attached one has. */
  passiveDeclines: Map<string, LocalCommandDeclineReason>
  declineReason?: LocalCommandDeclineReason
  result?: LocalCommandRunResult
  message?: string
  settledAt: number | null
}

export type LocalCommandRequestInput = {
  command: string
  cwd: string | null
  timeoutSec?: number
  reason: string | null
  agent: string | null
}

type Attachment = {
  deviceId: string
  emit: (event: LocalCommandStreamEvent) => void
}

export type LocalCommandTimer = (run: () => void, ms: number) => { cancel: () => void }

const realTimer: LocalCommandTimer = (run, ms) => {
  const handle = setTimeout(run, ms)
  // A waiting request must never keep orcad alive.
  handle.unref?.()
  return { cancel: () => clearTimeout(handle) }
}

/**
 * In-memory relay between an agent's request and the attached desktops (one orcad = one cloud
 * workspace). It never runs anything: it only records what each desktop reports, and only the
 * desktop that started a command may report its result.
 */
export class LocalCommandBroker {
  private readonly records = new Map<string, LocalCommandRecord>()
  private readonly attachments = new Map<string, Attachment>()
  private readonly timers = new Map<string, { cancel: () => void }>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => `lc_${randomBytes(16).toString('base64url')}`,
    private readonly timer: LocalCommandTimer = realTimer
  ) {}

  /** Returns detach. Pending requests are replayed so a desktop that reconnects can still answer. */
  attach(attachmentId: string, deviceId: string, emit: Attachment['emit']): () => void {
    this.attachments.set(attachmentId, { deviceId, emit })
    safeEmit(emit, { type: 'ready' })
    const now = this.now()
    for (const record of this.records.values()) {
      if (this.statusOf(record, now) === 'pending' && !record.passiveDeclines.has(deviceId)) {
        safeEmit(emit, toRequestedEvent(record, now))
      }
    }
    return () => {
      this.attachments.delete(attachmentId)
    }
  }

  hasAttachedDesktop(): boolean {
    return this.attachments.size > 0
  }

  request(input: LocalCommandRequestInput): LocalCommandRequestResult {
    if (this.attachments.size === 0) {
      throw new LocalCommandError(LOCAL_COMMAND_ERRORS.noDesktop)
    }
    const now = this.now()
    this.prune(now)
    const live = [...this.records.values()].filter((r) => {
      const status = this.statusOf(r, now)
      return status === 'pending' || status === 'running'
    })
    if (live.length >= LOCAL_COMMAND_MAX_PENDING) {
      throw new LocalCommandError(LOCAL_COMMAND_ERRORS.tooManyPending)
    }
    const lastHour = [...this.records.values()].filter((r) => now - r.requestedAt < HOUR_MS)
    if (lastHour.length >= LOCAL_COMMAND_MAX_PER_HOUR) {
      throw new LocalCommandError(LOCAL_COMMAND_ERRORS.rateLimited)
    }
    const record: LocalCommandRecord = {
      requestId: this.newId(),
      command: input.command,
      cwd: input.cwd,
      timeoutSec: input.timeoutSec ?? LOCAL_COMMAND_DEFAULT_TIMEOUT_SEC,
      reason: input.reason,
      agent: input.agent,
      requestedAt: now,
      expiresAt: now + LOCAL_COMMAND_APPROVAL_WINDOW_MS,
      status: 'pending',
      runningDeviceId: null,
      runDeadline: 0,
      passiveDeclines: new Map(),
      settledAt: null
    }
    this.records.set(record.requestId, record)
    this.schedule(record, record.expiresAt)
    this.broadcast(toRequestedEvent(record, now))
    return { requestId: record.requestId, status: 'pending' }
  }

  status(requestId: string): LocalCommandStatusResult {
    const record = this.require(requestId)
    const status = this.statusOf(record, this.now())
    return {
      requestId,
      status,
      ...(record.declineReason ? { declineReason: record.declineReason } : {}),
      ...(record.result ? { result: record.result } : {}),
      ...(record.message ? { message: record.message } : {})
    }
  }

  /** A desktop's report. Only an attached desktop may report, and only the starter may finish. */
  settle(deviceId: string, params: LocalCommandSettleParams): LocalCommandSettleResult {
    if (![...this.attachments.values()].some((a) => a.deviceId === deviceId)) {
      throw new LocalCommandError(LOCAL_COMMAND_ERRORS.forbidden)
    }
    const record = this.require(params.requestId)
    const now = this.now()
    const status = this.statusOf(record, now)
    switch (params.outcome) {
      case 'started': {
        if (status !== 'pending') {
          return { accepted: false, status }
        }
        record.status = 'running'
        record.runningDeviceId = deviceId
        record.runDeadline = now + record.timeoutSec * 1000 + LOCAL_COMMAND_RESULT_GRACE_MS
        this.schedule(record, record.runDeadline)
        // Other desktops drop their prompt; the request is no longer waiting for them.
        this.broadcast({ type: 'settled', requestId: record.requestId, status: 'running' })
        return { accepted: true, status: 'running' }
      }
      case 'finished':
      case 'failed': {
        if (status !== 'running' || record.runningDeviceId !== deviceId) {
          return { accepted: false, status }
        }
        if (params.outcome === 'finished') {
          record.result = params.result
        } else {
          record.message = params.message
        }
        this.finish(record, params.outcome, now)
        return { accepted: true, status: params.outcome }
      }
      case 'declined': {
        if (status !== 'pending') {
          return { accepted: false, status }
        }
        if (params.reason === 'denied') {
          record.declineReason = 'denied'
          this.finish(record, 'declined', now)
          return { accepted: true, status: 'declined' }
        }
        // A computer that can't take it (or whose person didn't answer) must not cancel another
        // computer's prompt: settle only once every attached desktop has passed.
        record.passiveDeclines.set(deviceId, params.reason)
        const attachedDevices = new Set([...this.attachments.values()].map((a) => a.deviceId))
        if ([...attachedDevices].every((device) => record.passiveDeclines.has(device))) {
          record.declineReason = [...record.passiveDeclines.values()].includes('not_allowed')
            ? 'not_allowed'
            : 'approval_timed_out'
          this.finish(record, 'declined', now)
          return { accepted: true, status: 'declined' }
        }
        return { accepted: true, status: 'pending' }
      }
    }
  }

  private finish(
    record: LocalCommandRecord,
    status: Exclude<LocalCommandStatus, 'pending' | 'running'>,
    now: number
  ): void {
    record.status = status
    record.settledAt = now
    this.timers.get(record.requestId)?.cancel()
    this.timers.delete(record.requestId)
    this.broadcast({ type: 'settled', requestId: record.requestId, status })
  }

  private schedule(record: LocalCommandRecord, at: number): void {
    this.timers.get(record.requestId)?.cancel()
    const handle = this.timer(
      () => {
        this.timers.delete(record.requestId)
        const now = this.now()
        const status = this.statusOf(record, now)
        if (status === 'expired' || status === 'lost') {
          this.finish(record, status, now)
        } else if (status === 'pending' || status === 'running') {
          this.schedule(record, status === 'pending' ? record.expiresAt : record.runDeadline)
        }
      },
      Math.max(0, at - this.now())
    )
    this.timers.set(record.requestId, handle)
  }

  private statusOf(record: LocalCommandRecord, now: number): LocalCommandStatus {
    if (record.status === 'pending' && now >= record.expiresAt) {
      return 'expired'
    }
    if (record.status === 'running' && now >= record.runDeadline) {
      return 'lost'
    }
    return record.status
  }

  private require(requestId: string): LocalCommandRecord {
    this.prune(this.now())
    const record = this.records.get(requestId)
    if (!record) {
      throw new LocalCommandError(LOCAL_COMMAND_ERRORS.notFound)
    }
    return record
  }

  private prune(now: number): void {
    for (const [id, record] of this.records) {
      const status = this.statusOf(record, now)
      const endedAt =
        record.settledAt ??
        (status === 'expired' ? record.expiresAt : status === 'lost' ? record.runDeadline : null)
      if (endedAt !== null && now - endedAt >= RECORD_RETENTION_MS) {
        this.records.delete(id)
      }
    }
  }

  private broadcast(event: LocalCommandStreamEvent): void {
    for (const attachment of this.attachments.values()) {
      safeEmit(attachment.emit, event)
    }
  }
}

function safeEmit(emit: Attachment['emit'], event: LocalCommandStreamEvent): void {
  try {
    emit(event)
  } catch {
    // One broken stream must not keep the other desktops from seeing the request.
  }
}

function toRequestedEvent(record: LocalCommandRecord, now: number): LocalCommandRequestedEvent {
  return {
    type: 'requested',
    requestId: record.requestId,
    command: record.command,
    cwd: record.cwd,
    timeoutSec: record.timeoutSec,
    reason: record.reason,
    agent: record.agent,
    expiresInMs: Math.max(0, record.expiresAt - now)
  }
}

let sharedBroker: LocalCommandBroker | null = null

export function getLocalCommandBroker(): LocalCommandBroker {
  sharedBroker ??= new LocalCommandBroker()
  return sharedBroker
}
