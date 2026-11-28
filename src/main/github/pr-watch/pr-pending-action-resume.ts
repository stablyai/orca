import { verifyOpenedPRAction } from './pr-opened-action-verification'
import * as PR from './pr-pending-action-types'
// Resumes captured PR obligations in bounded batches, off the user's action path. Deadlines are the
// ones fixed at capture; a restart resumes the same row and never renews them. Each obligation is
// saved as decided on its own, so a sibling still resolving never holds back or loses it.

import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRInfo } from '../../../shared/github/pull-requests/pull-request-types'
import { pushedPullRequestHead, type PushRemote } from './pr-chat-action-recorder'
import { PRPendingActionDrain } from './pr-pending-action-drain'
import {
  openPRPendingObligations,
  prPendingActionKey,
  type PRPendingActionRow,
  type PRPendingObligation
} from './pr-pending-actions'
import * as watch from './pr-watch-types'

const timing = PR.pendingActionTiming

type Transient = { transient: true }
const TRANSIENT: Transient = { transient: true }

export class PRPendingActionResume {
  private readonly pushes = new Set<PR.PendingPush>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly passes: PRPendingActionDrain<PRPendingActionRow>
  // Rows whose settle or defer committed this run; only those may wake another pass at once.
  private readonly committed = new WeakSet<PRPendingActionRow>()
  private stopped = false

  constructor(private readonly deps: PR.PRPendingActionResumeDeps) {
    this.passes = new PRPendingActionDrain({
      readDue: (limit, running) =>
        this.stopped || deps.database.readOnly || deps.database.isClosed
          ? null
          : limit > 0
            ? deps.database.read({ kind: 'due', now: deps.now(), limit, running: [...running] })
            : [],
      keyOf: prPendingActionKey,
      // A failing database fails the defer too: the row parks and the error is logged.
      start: (row) => void this.process(row).catch(this.failed),
      nextAt: () => deps.database.read({ kind: 'next', after: deps.now() }),
      failed: this.failed,
      now: deps.now
    })
  }

  clear(): void {
    this.stopped = true
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
    this.passes.stop()
    this.pushes.forEach((push) => void push.finish(null).catch(this.failed))
    this.pushes.clear()
  }

  drain(): void {
    this.passes.run()
  }

  private async process(row: PRPendingActionRow): Promise<void> {
    try {
      if (!this.deps.chatExists(row.chatId) || this.expired(row)) {
        return await this.settle(row, openPRPendingObligations(row), [])
      }
      const workspace = await this.deps.chatWorkspace(row.chatId)
      if (this.stopped) {
        return
      }
      if (workspace === 'not-git' || workspace?.connectionId) {
        return await this.settle(row, openPRPendingObligations(row), [])
      }
      if (!workspace) {
        return await this.retryOrExpire(row)
      }
      const results = await Promise.all(
        openPRPendingObligations(row).map((index) =>
          this.verify(row, index, workspace).catch(this.failed)
        )
      )
      if (results.includes(TRANSIENT)) {
        await this.retryOrExpire(row)
      }
    } catch (error) {
      this.failed(error)
      await this.retryOrExpire(row)
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

  private async settle(
    row: PRPendingActionRow,
    indices: number[],
    verified: PR.PRVerifiedAction[]
  ): Promise<void> {
    if (this.stopped || this.deps.database.isClosed || indices.length === 0) {
      return
    }
    await this.deps.settle(row, indices, this.expired(row) ? [] : verified)
    this.committed.add(row)
    indices.forEach((index) => (row.obligations[index].done = true))
  }

  private async retryOrExpire(row: PRPendingActionRow): Promise<void> {
    const { database, now } = this.deps
    if (this.stopped || database.isClosed) {
      return
    }
    if (this.expired(row)) {
      await this.settle(row, openPRPendingObligations(row), [])
      return
    }
    const delay = Math.min(timing.RETRY_BASE_MS * 2 ** row.attempts, timing.RETRY_MAX_MS)
    await database.write({ kind: 'defer', row, nextAt: now() + delay })
    this.committed.add(row)
  }

  private async verify(
    row: PRPendingActionRow,
    index: number,
    workspace: watch.PRWatchWorkspace
  ): Promise<Transient | void> {
    if (this.stopped) {
      return
    }
    const obligation = row.obligations[index]
    if (obligation.kind === 'opened') {
      const verified = await verifyOpenedPRAction(this.deps, row, obligation.target, workspace)
      return this.settle(row, [index], verified)
    }
    const remote = await this.deps.resolvePushRemote(workspace, obligation.evidence)
    if (this.stopped) {
      return
    }
    if (remote === null) {
      return TRANSIENT
    }
    if (this.expired(row)) {
      return this.settle(row, [index], [])
    }
    await this.awaitPush(row, index, workspace, obligation, remote === 'unknown' ? null : remote)
  }

  private awaitPush(
    row: PRPendingActionRow,
    index: number,
    workspace: watch.PRWatchWorkspace,
    obligation: Extract<PRPendingObligation, { kind: 'pushed' }>,
    remote: PushRemote | null
  ): Promise<void> {
    const late = this.deps.now() >= row.verifyDeadlineAt
    const deadline = late ? this.deps.now() + timing.LATE_PUSH_WINDOW_MS : row.verifyDeadlineAt
    const base = watch.prWatchCandidate(workspace, null)
    const branch = obligation.target.branch
    const candidate = { ...base, branch, cacheKey: `${base.cacheKey}>${branch}` }
    return new Promise((resolve, reject) => {
      const push: PR.PendingPush = {
        candidate,
        update: { branch, newSha: obligation.evidence.newSha },
        remote,
        late,
        deadline,
        resolving: false,
        noPRReads: 0,
        row,
        finish: async (result) => {
          if (!this.pushes.has(push) || push.finishing) {
            return push.finishing
          }
          push.finishing = this.settle(row, [index], result ? [result] : []).then(
            () => {
              this.pushes.delete(push)
              resolve()
            },
            (error: unknown) => {
              this.pushes.delete(push)
              reject(error)
              throw error
            }
          )
          return push.finishing
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
          void push.finish(null).catch(this.failed)
          return
        }
        this.deps.readAfterPush(candidate)
        this.later(
          read,
          Math.min(timing.PUSH_READ_INTERVAL_MS, Math.max(1_000, deadline - this.deps.now()))
        )
      }
      read()
    })
  }

  async verifyRead(
    candidate: GitHubPRRefreshCandidate,
    pr: PRInfo,
    observedAt: number
  ): Promise<void> {
    const prKey = watch.prKeyOf(pr)
    const key = prKey ? watch.parsePRKey(prKey) : null
    const direct: Promise<void>[] = []
    for (const push of this.pushes) {
      const head =
        key &&
        !push.resolving &&
        !push.finishing &&
        this.deps.now() < push.deadline &&
        push.candidate.repoPath === candidate.repoPath
          ? pushedPullRequestHead(push.update, push.remote, pr)
          : null
      if (key && head) {
        const settling = this.settleVerified(push, key, pr, head, observedAt)
        if (head.superseded) {
          void settling.catch(this.failed)
        } else {
          direct.push(settling)
        }
      }
    }
    await Promise.all(direct)
  }

  async noteNoPR(candidate: GitHubPRRefreshCandidate, observedAt: number): Promise<void> {
    for (const push of this.pushes) {
      if (
        push.candidate.cacheKey === candidate.cacheKey &&
        observedAt >= push.row.finishedAt + timing.NO_PR_LAG_MS &&
        ++push.noPRReads >= timing.NO_PR_READS
      ) {
        await push.finish(null)
      }
    }
  }

  private async settleVerified(
    push: PR.PendingPush,
    key: watch.ParsedPRKey,
    pr: PRInfo,
    head: { headSha: string; superseded: boolean },
    observedAt: number
  ): Promise<void> {
    if (this.stopped) {
      return
    }
    const { row } = push
    const verified = (headSha: string | null, movedAt: number | null): PR.PRVerifiedAction => ({
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
      await push.finish(verified(head.headSha, null))
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
      if (!this.stopped && result !== undefined && this.deps.now() < push.deadline) {
        await push.finish(result)
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
