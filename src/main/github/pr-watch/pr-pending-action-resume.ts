// Resumes captured PR obligations in bounded batches, off the user's action path. Deadlines are the
// ones fixed at capture; a restart resumes the same row and never renews them.

import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-request-refresh-types'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import { pushedPullRequestHead, type PushRemote } from './pr-chat-action-recorder'
import type { PRPendingActionResumeDeps, PRVerifiedAction } from './pr-pending-action-types'
import {
  deferPRPendingAction,
  nextPRPendingActionAt,
  readDuePRPendingActions,
  type PRPendingActionRow,
  type PRPendingObligation
} from './pr-pending-actions'
import type { PRChatAction } from './pr-watch-tables'
import {
  parsePRKey,
  prKeyOf,
  prWatchCandidate,
  type ParsedPRKey,
  type PRWatchWorkspace
} from './pr-watch-types'

const BATCH_LIMIT = 20
const PUSH_READ_INTERVAL_MS = 20_000
// After the verify deadline, one or two reads decide a late push.
const LATE_PUSH_WINDOW_MS = 40_000
const RETRY_BASE_MS = 15_000
const RETRY_MAX_MS = 30 * 60_000

type Transient = { transient: true }
const TRANSIENT: Transient = { transient: true }

type PendingPush = {
  candidate: GitHubPRRefreshCandidate
  update: { branch: string; newSha: string | null }
  remote: PushRemote | null
  late: boolean
  resolving: boolean
  settle: (result: PRVerifiedAction | null) => void
  row: PRPendingActionRow
}

export class PRPendingActionResume {
  private readonly inFlight = new Set<string>()
  private readonly pushes = new Set<PendingPush>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly deps: PRPendingActionResumeDeps) {}

  clear(): void {
    this.stopped = true
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
    }
    this.pushes.forEach((push) => push.settle(null))
    this.pushes.clear()
  }

  /** One bounded pass of due rows; the next pass is timed to the earliest backoff. */
  drain(): void {
    const { database, now } = this.deps
    if (this.stopped || database.readOnly || database.isClosed) {
      return
    }
    const due = readDuePRPendingActions(database.db, now(), BATCH_LIMIT + this.inFlight.size)
    for (const row of due.filter((row) => !this.inFlight.has(rowKey(row))).slice(0, BATCH_LIMIT)) {
      void this.process(row)
    }
    const next = nextPRPendingActionAt(database.db)
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
    }
    this.drainTimer =
      next === null ? null : this.later(() => this.drain(), Math.max(1_000, next - now()))
  }

  private async process(row: PRPendingActionRow): Promise<void> {
    const key = rowKey(row)
    this.inFlight.add(key)
    try {
      if (!this.deps.chatExists(row.chatId)) {
        return this.deps.complete(row, [])
      }
      const workspace = await this.deps.chatWorkspace(row.chatId)
      if (workspace === 'not-git') {
        return this.deps.complete(row, [])
      }
      const results = workspace
        ? await Promise.all(
            row.obligations.map((obligation) => this.verify(row, workspace, obligation))
          )
        : [TRANSIENT]
      if (results.some((result) => result === TRANSIENT)) {
        return this.retryOrExpire(row)
      }
      if (!this.stopped) {
        this.deps.complete(
          row,
          results.flatMap((result) => (Array.isArray(result) ? result : []))
        )
      }
    } catch (error) {
      this.deps.logger.warn('resuming a pull request action failed', { scope: 'pr-watch', error })
      this.retryOrExpire(row)
    } finally {
      this.inFlight.delete(key)
    }
  }

  /** Transient resolution failures back off until the resolve deadline, then end the row. */
  private retryOrExpire(row: PRPendingActionRow): void {
    const { database, now } = this.deps
    if (this.stopped || database.isClosed) {
      return
    }
    if (now() >= row.resolveDeadlineAt) {
      this.deps.complete(row, [])
      return
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** row.attempts, RETRY_MAX_MS)
    database.transaction((db) => deferPRPendingAction(db, row, now() + delay))
    this.drain()
  }

  private async verify(
    row: PRPendingActionRow,
    workspace: PRWatchWorkspace,
    obligation: PRPendingObligation
  ): Promise<PRVerifiedAction[] | Transient> {
    if (obligation.kind === 'opened') {
      const pr = obligation.target
      // Only a PR in one of the chat repository's own GitHub remotes gets lines.
      const own = (await this.deps.repositories(workspace)).some(
        (repo) =>
          repo.owner.toLowerCase() === pr.owner.toLowerCase() &&
          repo.repo.toLowerCase() === pr.repo.toLowerCase() &&
          (repo.host ?? 'github.com').toLowerCase() === pr.forgeHost.toLowerCase()
      )
      const action: PRChatAction = {
        chatId: row.chatId,
        anchor: row.anchor,
        ...pr,
        kind: 'opened',
        headSha: null,
        observedAt: row.finishedAt
      }
      return own
        ? [{ action, candidate: prWatchCandidate(workspace, pr.number), movedAt: null }]
        : []
    }
    const remote = await this.deps.resolvePushRemote(workspace, obligation.evidence)
    if (remote === null) {
      return TRANSIENT
    }
    const verified = await this.awaitPush(
      row,
      workspace,
      obligation,
      remote === 'unknown' ? null : remote
    )
    return verified ? [verified] : []
  }

  /** Resolves when a PR read proves the push, or with null once its window closes. */
  private awaitPush(
    row: PRPendingActionRow,
    workspace: PRWatchWorkspace,
    obligation: Extract<PRPendingObligation, { kind: 'pushed' }>,
    remote: PushRemote | null
  ): Promise<PRVerifiedAction | null> {
    const late = this.deps.now() >= row.verifyDeadlineAt
    const deadline = late ? this.deps.now() + LATE_PUSH_WINDOW_MS : row.verifyDeadlineAt
    const base = prWatchCandidate(workspace, null)
    const branch = obligation.target.branch
    // Each pushed branch is read by name: `work:review` updated review, whatever is checked out.
    const candidate = { ...base, branch, cacheKey: `${base.cacheKey}>${branch}` }
    return new Promise((resolve) => {
      const push: PendingPush = {
        candidate,
        update: { branch, newSha: obligation.evidence.newSha },
        remote,
        late,
        resolving: false,
        row,
        settle: (result) => {
          if (this.pushes.delete(push)) {
            resolve(result)
          }
        }
      }
      this.pushes.add(push)
      const read = () => {
        if (!this.pushes.has(push)) {
          return
        }
        if (push.resolving) {
          this.later(read, 1_000)
          return
        }
        if (this.deps.now() >= deadline) {
          push.settle(null)
          return
        }
        this.deps.readAfterPush(candidate)
        this.later(
          read,
          Math.min(PUSH_READ_INTERVAL_MS, Math.max(1_000, deadline - this.deps.now()))
        )
      }
      read()
    })
  }

  /** Runs on every PR read before it is evaluated, so the push's own result reaches its chat. */
  verifyRead(candidate: GitHubPRRefreshCandidate, pr: PRInfo, observedAt: number): void {
    const prKey = prKeyOf(pr)
    const key = prKey ? parsePRKey(prKey) : null
    for (const push of this.pushes) {
      const head =
        key && !push.resolving && push.candidate.repoPath === candidate.repoPath
          ? pushedPullRequestHead(push.update, push.remote, pr)
          : null
      if (key && head) {
        void this.settleVerified(push, key, pr, head, observedAt)
      }
    }
  }

  private async settleVerified(
    push: PendingPush,
    key: ParsedPRKey,
    pr: PRInfo,
    head: { headSha: string; superseded: boolean },
    observedAt: number
  ): Promise<void> {
    push.resolving = true
    const { row } = push
    const verified = (headSha: string | null, movedAt: number | null): PRVerifiedAction => ({
      action: {
        chatId: row.chatId,
        anchor: row.anchor,
        forgeHost: key.host,
        owner: key.owner,
        repo: key.repo,
        number: key.number,
        kind: 'pushed',
        headSha,
        observedAt
      },
      candidate: {
        ...push.candidate,
        branch: pr.headRefName ?? push.candidate.branch,
        linkedPRNumber: key.number,
        cacheKey: `${push.candidate.cacheKey}#${key.number}`
      },
      movedAt
    })
    try {
      if (!head.superseded) {
        push.settle(verified(head.headSha, null))
      } else if (push.late) {
        // Verified after its window: ownership only, and only when the commit is already on the PR.
        const onPR = await this.deps.isCommitInPRHead(
          push.candidate,
          key,
          head.headSha,
          pr.headSha!
        )
        push.settle(onPR ? verified(null, null) : null)
      } else {
        // Every head is keyed by its full SHA, so a later read of the same commit finds its memory.
        const full = await this.deps.resolveCommitSha(push.candidate, key, head.headSha)
        if (full) {
          push.settle(verified(full, this.deps.now()))
        }
      }
    } catch (error) {
      this.deps.logger.warn('verifying a push failed', { scope: 'pr-watch', error })
    } finally {
      push.resolving = false
    }
  }

  private later(run: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      run()
    }, delayMs)
    timer.unref?.()
    this.timers.add(timer)
    return timer
  }
}

function rowKey(row: PRPendingActionRow): string {
  return `${row.chatId}\0${row.anchor.itemId}`
}
