import { randomBytes } from 'node:crypto'
import {
  SECRET_REQUEST_ERRORS,
  SECRET_REQUEST_MAX_LIFETIME_MS,
  SECRET_REQUEST_MAX_PENDING,
  SECRET_REQUEST_MAX_PER_HOUR,
  SECRET_REQUEST_TTL_MS,
  SECRETS_REQUEST_SETTLED_EVENT,
  SECRETS_REQUESTED_EVENT,
  type SecretRequestedEvent,
  type SecretRequestScope,
  type SecretRequestSettledEvent,
  type SecretRequestStatus,
  type SecretsRequestResult,
  type SecretsRequestStatusResult,
  type SecretsResolveRequestResult,
  type SecretsTouchRequestResult
} from '../../../shared/secret-request-contract'
import { secretRequestNameRefusal } from '../../../shared/secret-request-names'

const HOUR_MS = 60 * 60_000

export class SecretRequestError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'SecretRequestError'
  }
}

type SecretRequestRecord = {
  requestId: string
  name: string
  reason: string
  scope: SecretRequestScope
  agent: string | null
  worktreeId: string | null
  terminalHandle: string | null
  requestedAt: number
  expiresAt: number
  outcome: 'provided' | 'declined' | null
}

export type SecretRequestInput = {
  name: string
  reason: string
  scope?: SecretRequestScope
  /** Derived by the caller from the terminal's agent session, never from request params. */
  agent: string | null
  worktreeId: string | null
  terminalHandle: string | null
  /** Names currently in the session env. */
  sessionEnvNames: ReadonlySet<string>
}

export type SecretRequestStoreEvent = SecretRequestedEvent | SecretRequestSettledEvent

/** In-memory only (never on disk): one orcad serves one cloud workspace, so limits and dedupe are
 *  per store. Records outlive their request by an hour so `--wait` can read the outcome. */
export class SecretRequestStore {
  private readonly records = new Map<string, SecretRequestRecord>()
  private readonly listeners = new Set<(event: SecretRequestStoreEvent) => void>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => `sr_${randomBytes(12).toString('base64url')}`
  ) {}

  request(input: SecretRequestInput): SecretsRequestResult {
    const refusal = secretRequestNameRefusal(input.name)
    if (refusal) {
      throw new SecretRequestError(refusal)
    }
    if (input.sessionEnvNames.has(input.name)) {
      return { requestId: null, status: 'already-set' }
    }
    const now = this.now()
    this.prune(now)
    const pending = [...this.records.values()].filter((r) => this.statusOf(r, now) === 'pending')
    const same = pending.find((r) => r.name === input.name)
    if (same) {
      return { requestId: same.requestId, status: 'pending' }
    }
    if (pending.length >= SECRET_REQUEST_MAX_PENDING) {
      throw new SecretRequestError(SECRET_REQUEST_ERRORS.tooManyPending)
    }
    const lastHour = [...this.records.values()].filter((r) => now - r.requestedAt < HOUR_MS)
    if (lastHour.length >= SECRET_REQUEST_MAX_PER_HOUR) {
      throw new SecretRequestError(SECRET_REQUEST_ERRORS.rateLimited)
    }
    const record: SecretRequestRecord = {
      requestId: this.newId(),
      name: input.name,
      reason: input.reason,
      scope: input.scope ?? 'personal',
      agent: input.agent,
      worktreeId: input.worktreeId,
      terminalHandle: input.terminalHandle,
      requestedAt: now,
      expiresAt: now + SECRET_REQUEST_TTL_MS,
      outcome: null
    }
    this.records.set(record.requestId, record)
    this.emit(toRequestedEvent(record))
    return { requestId: record.requestId, status: 'pending' }
  }

  status(requestId: string): SecretsRequestStatusResult {
    const record = this.require(requestId)
    return {
      requestId,
      name: record.name,
      status: this.statusOf(record, this.now()),
      expiresAt: record.expiresAt
    }
  }

  /** D3: the card is in use, so keep the agent waiting: now + 15 min, capped at 60 min after the request. */
  touch(requestId: string): SecretsTouchRequestResult {
    const record = this.require(requestId)
    const now = this.now()
    if (this.statusOf(record, now) !== 'pending') {
      throw new SecretRequestError(SECRET_REQUEST_ERRORS.notPending)
    }
    record.expiresAt = Math.min(
      now + SECRET_REQUEST_TTL_MS,
      record.requestedAt + SECRET_REQUEST_MAX_LIFETIME_MS
    )
    return { expiresAt: record.expiresAt }
  }

  /** First outcome wins. A request that expired mid-save reports `expired`; the saved value stands. */
  resolve(requestId: string, outcome: 'provided' | 'declined'): SecretsResolveRequestResult {
    const record = this.require(requestId)
    const status = this.statusOf(record, this.now())
    if (status !== 'pending') {
      return { outcome: status }
    }
    record.outcome = outcome
    this.emit({ type: SECRETS_REQUEST_SETTLED_EVENT, requestId, status: outcome })
    return { outcome }
  }

  /** Requests still waiting, for replay to a client that attaches later. */
  pendingEvents(): SecretRequestedEvent[] {
    const now = this.now()
    return [...this.records.values()]
      .filter((r) => this.statusOf(r, now) === 'pending')
      .map(toRequestedEvent)
  }

  subscribe(listener: (event: SecretRequestStoreEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private statusOf(record: SecretRequestRecord, now: number): SecretRequestStatus {
    if (record.outcome) {
      return record.outcome
    }
    return now >= record.expiresAt ? 'expired' : 'pending'
  }

  private require(requestId: string): SecretRequestRecord {
    this.prune(this.now())
    const record = this.records.get(requestId)
    if (!record) {
      throw new SecretRequestError(SECRET_REQUEST_ERRORS.notFound)
    }
    return record
  }

  private prune(now: number): void {
    for (const [id, record] of this.records) {
      if (now - record.requestedAt >= SECRET_REQUEST_MAX_LIFETIME_MS + HOUR_MS) {
        this.records.delete(id)
      }
    }
  }

  private emit(event: SecretRequestStoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // One broken subscriber must not keep the others from seeing the request.
      }
    }
  }
}

function toRequestedEvent(record: SecretRequestRecord): SecretRequestedEvent {
  return {
    type: SECRETS_REQUESTED_EVENT,
    requestId: record.requestId,
    name: record.name,
    reason: record.reason,
    scope: record.scope,
    agent: record.agent,
    worktreeId: record.worktreeId,
    ...(record.terminalHandle ? { terminalHandle: record.terminalHandle } : {}),
    requestedAt: record.requestedAt,
    expiresAt: record.expiresAt
  }
}

/** Phones show status only: no agent-written text. */
export function phoneSecretRequestEvent(event: SecretRequestStoreEvent): SecretRequestStoreEvent {
  if (event.type !== SECRETS_REQUESTED_EVENT) {
    return event
  }
  const { reason: _reason, terminalHandle: _terminalHandle, ...status } = event
  return status
}

let sharedStore: SecretRequestStore | null = null

/** The process's store: orcad's requests live as long as orcad. */
export function getSecretRequestStore(): SecretRequestStore {
  sharedStore ??= new SecretRequestStore()
  return sharedStore
}
