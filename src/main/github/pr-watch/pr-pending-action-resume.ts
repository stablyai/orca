// Resumes captured PR obligations in bounded batches, off the user's action path. Deadlines are the
// ones fixed at capture; a restart resumes the same row and never renews them. Each obligation is
// saved as decided on its own, so a sibling still resolving never holds back or loses it.

import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRInfo } from '../../../shared/github/pull-requests/pull-request-types'
import { pushedPullRequestHead, type PushRemote } from './pr-chat-action-recorder'
import { PRPendingActionDrain } from './pr-pending-action-drain'
import type { PRPendingActionResumeDeps, PRVerifiedAction } from './pr-pending-action-types'
import {
  deferPRPendingAction,
  nextPRPendingActionAt,
  openPRPendingObligations,
  prPendingActionKey,
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

const PUSH_READ_INTERVAL_MS = 20_000
// After the verify deadline, one or two reads decide a late push.
const LATE_PUSH_WINDOW_MS = 40_000
// GitHub shows a push on its PR within this; after it, two reads finding no PR end the push.
const NO_PR_LAG_MS = 2 * 60_000
const NO_PR_READS = 2
const RETRY_BASE_MS = 15_000
const RETRY_MAX_MS = 30 * 60_000

type Transient = { transient: true }
const TRANSIENT: Transient = { transient: true }

type PendingPush = {
  candidate: GitHubPRRefreshCandidate
  update: { branch: string; newSha: string | null }
  remote: PushRemote | null
  late: boolean
  deadline: number
  resolving: boolean
  noPRReads: number
  finish: (result: PRVerifiedAction | null) => void
  row: PRPendingActionRow
}

export class PRPendingActionResume {
  private readonly pushes = new Set<PendingPush>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly passes: PRPendingActionDrain<PRPendingActionRow>
  // Rows whose settle or defer committed this run; only those may wake another pass at once.
  private readonly committed = new WeakSet<PRPendingActionRow>()
  private stopped = false

  constructor(private readonly deps: PRPendingActionResumeDeps) {
    this.passes = new PRPendingActionDrain({
      readDue: (limit, running) =>
        this.stopped || deps.database.readOnly || deps.database.isClosed
          ? null
          : limit > 0
            ? readDuePRPendingActions(deps.database.db, deps.now(), limit, running)
            : [],
      keyOf: prPendingActionKey,
      // A failing database fails the defer too: the row parks and the error is logged.
      start: (row) => void this.process(row).catch(this.failed),
      nextAt: () => nextPRPendingActionAt(deps.database.db, deps.now()),
      now: deps.now
    })
  }

  clear(): void {
    this.stopped = true
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
    this.passes.stop()
    this.pushes.forEach((push) => push.finish(null))
    this.pushes.clear()
  }

  /** Starts due rows up to the running limit; the next pass is timed to the earliest backoff. */
  drain(): void {
    this.passes.run()
  }

  /** Runs a row `drain` reserved. */
  private async process(row: PRPendingActionRow): Promise<void> {
    try {
      if (!this.deps.chatExists(row.chatId) || this.expired(row)) {
        return this.settle(row, openPRPendingObligations(row), [])
      }
      const workspace = await this.deps.chatWorkspace(row.chatId)
      // This process serves no SSH checkout: its host's own runtime captures and resolves its pushes.
      if (workspace === 'not-git' || workspace?.connectionId) {
        return this.settle(row, openPRPendingObligations(row), [])
      }
      if (!workspace) {
        return this.retryOrExpire(row)
      }
      const results = await Promise.all(
        openPRPendingObligations(row).map((index) =>
          this.verify(row, index, workspace).catch(this.failed)
        )
      )
      if (results.includes(TRANSIENT)) {
        this.retryOrExpire(row)
      }
    } catch (error) {
      this.failed(error)
      this.retryOrExpire(row)
    } finally {
      this.passes.release(row, this.committed.has(row))
    }
  }

  private readonly failed = (error: unknown): Transient => {
    this.deps.logger.warn('resuming a pull request action failed', { scope: 'pr-watch', error })
    return TRANSIENT
  }

  private expired(row: PRPendingActionRow): boolean {
    return this.deps.now() >= row.resolveDeadlineAt
  }

  /** The saved expiry holds on success too: nothing verified after it becomes an action. */
  private settle(row: PRPendingActionRow, indices: number[], verified: PRVerifiedAction[]): void {
    if (this.stopped || this.deps.database.isClosed || indices.length === 0) {
      return
    }
    this.deps.settle(row, indices, this.expired(row) ? [] : verified)
    this.committed.add(row)
    indices.forEach((index) => (row.obligations[index].done = true))
  }

  /** Obligations still resolving back off until the resolve deadline, then end. */
  private retryOrExpire(row: PRPendingActionRow): void {
    const { database, now } = this.deps
    if (this.stopped || database.isClosed) {
      return
    }
    if (this.expired(row)) {
      this.settle(row, openPRPendingObligations(row), [])
      return
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** row.attempts, RETRY_MAX_MS)
    database.transaction((db) => deferPRPendingAction(db, row, now() + delay))
    this.committed.add(row)
  }

  private async verify(
    row: PRPendingActionRow,
    index: number,
    workspace: PRWatchWorkspace
  ): Promise<Transient | void> {
    const obligation = row.obligations[index]
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
      const candidate = prWatchCandidate(workspace, pr.number)
      return this.settle(row, [index], own ? [{ action, candidate, movedAt: null }] : [])
    }
    const remote = await this.deps.resolvePushRemote(workspace, obligation.evidence)
    if (remote === null) {
      return TRANSIENT
    }
    if (this.expired(row)) {
      return this.settle(row, [index], [])
    }
    await this.awaitPush(row, index, workspace, obligation, remote === 'unknown' ? null : remote)
  }

  /** Settles the push once a PR read proves it, or with nothing once its window closes. */
  private awaitPush(
    row: PRPendingActionRow,
    index: number,
    workspace: PRWatchWorkspace,
    obligation: Extract<PRPendingObligation, { kind: 'pushed' }>,
    remote: PushRemote | null
  ): Promise<void> {
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
        deadline,
        resolving: false,
        noPRReads: 0,
        row,
        // Synchronous, so a read that proves the push saves its owner before that read is evaluated.
        finish: (result) => {
          if (this.pushes.delete(push)) {
            this.settle(row, [index], result ? [result] : [])
            resolve()
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
          push.finish(null)
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
        key &&
        !push.resolving &&
        this.deps.now() < push.deadline &&
        push.candidate.repoPath === candidate.repoPath
          ? pushedPullRequestHead(push.update, push.remote, pr)
          : null
      if (key && head) {
        void this.settleVerified(push, key, pr, head, observedAt)
      }
    }
  }

  /** A pushed branch GitHub still shows no PR for, past its lag, ends after a second such read. */
  noteNoPR(candidate: GitHubPRRefreshCandidate, observedAt: number): void {
    for (const push of this.pushes) {
      if (
        push.candidate.cacheKey === candidate.cacheKey &&
        observedAt >= push.row.finishedAt + NO_PR_LAG_MS &&
        ++push.noPRReads >= NO_PR_READS
      ) {
        push.finish(null)
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
    if (!head.superseded) {
      push.finish(verified(head.headSha, null))
      return
    }
    push.resolving = true
    try {
      // Verified after its window: ownership only, and only when the commit is already on the PR.
      // Otherwise every head is keyed by its full SHA, so a later read of the same commit finds it.
      const result = push.late
        ? (await this.deps.isCommitInPRHead(push.candidate, key, head.headSha, pr.headSha!))
          ? verified(null, null)
          : null
        : await this.deps
            .resolveCommitSha(push.candidate, key, head.headSha)
            .then((full) => (full ? verified(full, this.deps.now()) : undefined))
      // A lookup that outlived the window decides nothing; the read loop ends the push.
      if (result !== undefined && this.deps.now() < push.deadline) {
        push.finish(result)
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
