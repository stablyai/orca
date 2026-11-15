import {
  PR_DETAIL_RECOVERY_LEASE_MS,
  PR_DETAIL_RECOVERY_MAX_TICKETS,
  prDetailRecoveryIdentityDigest,
  type PRDetailRecoveryNotAdmittedReason,
  type PRDetailRecoverySnapshot,
  type PRDetailRecoveryStartArgs
} from '../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import {
  snapshotTicket,
  refusedSnapshot,
  type PRDetailRecoveryCaller,
  type PRDetailRecoveryTicket
} from './pr-detail-recovery-ticket-model'

export type RecoveryStart = {
  key: string
  caller: PRDetailRecoveryCaller
  args: PRDetailRecoveryStartArgs
  digest: string
  deadline: number
  resolving: boolean
  ticket?: PRDetailRecoveryTicket
  result?: PRDetailRecoverySnapshot
  promise: Promise<PRDetailRecoverySnapshot>
  deliver: (snapshot: PRDetailRecoverySnapshot) => void
}

/** Replay protection lasts exactly as long as the bounded ticket/resolver record. */
export class PRDetailRecoveryStarts {
  private readonly operations = new Map<string, RecoveryStart>()
  private readonly byCaller = new Map<string, Set<RecoveryStart>>()
  private readonly cleanups = new Map<string, () => void>()

  private acceptSequence = 0

  constructor(
    private readonly actions: {
      create: (
        start: RecoveryStart,
        candidate: GitHubPRRefreshCandidate,
        sequence: number
      ) => PRDetailRecoveryTicket
      revoke: (ticket: PRDetailRecoveryTicket) => void
      schedule: () => void
    }
  ) {}

  start(
    caller: PRDetailRecoveryCaller,
    args: PRDetailRecoveryStartArgs,
    resolved: GitHubPRRefreshCandidate | PRDetailRecoveryNotAdmittedReason
  ): PRDetailRecoverySnapshot {
    const acquired = this.acquire(caller, args)
    if (!('start' in acquired)) {
      return acquired
    }
    const { start, created } = acquired
    return created ? this.finish(start, resolved) : this.snapshot(start)
  }

  startResolving(
    caller: PRDetailRecoveryCaller,
    args: PRDetailRecoveryStartArgs,
    resolve: () => Promise<GitHubPRRefreshCandidate | PRDetailRecoveryNotAdmittedReason>
  ): Promise<PRDetailRecoverySnapshot> {
    const acquired = this.acquire(caller, args)
    if (!('start' in acquired)) {
      return Promise.resolve(acquired)
    }
    const { start, created } = acquired
    if (!created) {
      return start.ticket ? Promise.resolve(this.snapshot(start)) : start.promise
    }
    // Reservation precedes resolution; expiry never frees a genuinely unresolved task.
    start.resolving = true
    this.actions.schedule()
    void Promise.resolve()
      .then(() => {
        if (start.result || caller.authority?.signal.aborted) {
          return 'validation' as const
        }
        return resolve()
      })
      .then(
        (resolved) => {
          start.resolving = false
          start.deliver(this.finish(start, resolved))
        },
        () => {
          start.resolving = false
          start.deliver(this.finish(start, 'validation'))
        }
      )
    return start.promise
  }

  private snapshot(start: RecoveryStart): PRDetailRecoverySnapshot {
    if (start.ticket) {
      if (!start.ticket.terminal) {
        start.ticket.leaseUntil = Date.now() + PR_DETAIL_RECOVERY_LEASE_MS
      }
      return snapshotTicket(start.ticket)
    }
    return (
      start.result ??
      refusedSnapshot(start.args.identity, { kind: 'not-admitted', reason: 'capacity' })
    )
  }

  private finish(
    start: RecoveryStart,
    resolved: GitHubPRRefreshCandidate | PRDetailRecoveryNotAdmittedReason
  ): PRDetailRecoverySnapshot {
    if (start.result || start.caller.authority?.signal.aborted || typeof resolved === 'string') {
      this.forget(start)
      return (
        start.result ??
        refusedSnapshot(start.args.identity, {
          kind: 'not-admitted',
          reason: typeof resolved === 'string' ? resolved : 'validation'
        })
      )
    }
    this.acceptSequence += 1
    start.ticket = this.actions.create(start, resolved, this.acceptSequence)
    return snapshotTicket(start.ticket)
  }

  private acquire(
    caller: PRDetailRecoveryCaller,
    args: PRDetailRecoveryStartArgs
  ): { start: RecoveryStart; created: boolean } | PRDetailRecoverySnapshot {
    const refuse = (reason: 'validation' | 'epoch-conflict' | 'capacity') =>
      refusedSnapshot(args.identity, { kind: 'not-admitted', reason })
    if (
      caller.authority?.signal.aborted ||
      !/^g\d{1,16}\.[\w-]{1,100}$/.test(args.clientEpoch.scope)
    ) {
      return refuse('validation')
    }
    const key = JSON.stringify([
      caller.callerKey,
      caller.authority?.id,
      args.clientEpoch.scope,
      args.clientEpoch.counter
    ])
    const digest = prDetailRecoveryIdentityDigest(args.identity)
    const existing = this.operations.get(key)
    if (existing) {
      return existing.digest === digest
        ? { start: existing, created: false }
        : refuse('epoch-conflict')
    }
    // All live, terminal and unresolved starts share one budget; refusal never scans callers.
    if (this.operations.size >= PR_DETAIL_RECOVERY_MAX_TICKETS) {
      return refuse('capacity')
    }
    let deliver!: RecoveryStart['deliver']
    const promise = new Promise<PRDetailRecoverySnapshot>((resolve) => {
      deliver = resolve
    })
    const start: RecoveryStart = {
      key,
      caller,
      args,
      digest,
      promise,
      deliver,
      resolving: false,
      deadline: Date.now() + PR_DETAIL_RECOVERY_LEASE_MS
    }
    this.operations.set(key, start)
    let owned = this.byCaller.get(caller.callerKey)
    if (!owned) {
      owned = new Set()
      this.byCaller.set(caller.callerKey, owned)
      if (caller.authority) {
        const revoke = (): void => this.cancelCaller(caller.callerKey)
        caller.authority.signal.addEventListener('abort', revoke, { once: true })
        this.cleanups.set(caller.callerKey, () =>
          caller.authority?.signal.removeEventListener('abort', revoke)
        )
      }
    }
    owned.add(start)
    return { start, created: true }
  }

  cancelCaller(callerKey: string): void {
    for (const start of this.byCaller.get(callerKey) ?? []) {
      if (start.ticket) {
        this.actions.revoke(start.ticket)
      } else {
        start.result = refusedSnapshot(start.args.identity, { kind: 'cancelled' })
        start.deliver(start.result)
      }
    }
  }

  forgetTicket(ticket: PRDetailRecoveryTicket): void {
    const start = this.operations.get(ticket.epochKey)
    if (start?.ticket === ticket) {
      this.forget(start)
    }
  }

  forget(start: RecoveryStart): void {
    if (start.resolving) {
      return
    }
    this.operations.delete(start.key)
    const owned = this.byCaller.get(start.caller.callerKey)
    owned?.delete(start)
    if (owned?.size === 0) {
      this.byCaller.delete(start.caller.callerKey)
      this.cleanups.get(start.caller.callerKey)?.()
      this.cleanups.delete(start.caller.callerKey)
    }
  }

  tick(now: number): number | null {
    let next = Infinity
    for (const start of this.operations.values()) {
      if (start.ticket || start.result) {
        continue
      }
      if (start.deadline <= now) {
        start.result = refusedSnapshot(start.args.identity, { kind: 'expired' })
        start.deliver(start.result)
        // A hung underlying resolver still occupies its reservation, until it actually settles.
      } else {
        next = Math.min(next, start.deadline)
      }
    }
    return Number.isFinite(next) ? next : null
  }
}
