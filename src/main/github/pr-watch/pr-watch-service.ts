import { orderPRWatchOutcome } from './pr-watch-outcome-order'
import { sweepGonePRChats } from './pr-watch-chat-retirement'
// The host's CI-line service: chats' verified PR actions start watches the pr-refresh queue reads;
// each new final result on a head becomes one line in every chat that owned the PR when it landed.

import type * as reads from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { pullRequestKey } from '../../../shared/native-chat/native-chat-pull-request-event'
import type { JournalWriterCommit } from '../../native-chat/agent-session-journal/journal-writer-changes'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { resolveGitHubApiRepositoryCandidates } from '../repositories/github-api-repository'
import { observedPRCheckRollup } from '../client/lookup/pr-refresh-outcome-assembly'
import * as refresh from '../pull-requests/refresh/pr-refresh-coordinator'
import {
  prWatchSettled,
  prWatchNextDueAt,
  type PRWatchJob
} from '../pull-requests/refresh/pr-refresh-watch-jobs'
import { PREarlierHeadJobs } from './pr-earlier-head-jobs'
import { PREventDeliveryTrigger } from './pr-event-delivery'
import { isCommitInPRHead, resolvePRCommitSha } from './pr-head-check-read'
import { PRPendingActionResume } from './pr-pending-action-resume'
import type { PRVerifiedAction } from './pr-pending-action-types'
import { finishesPRActionCall, type PRPendingActionRow } from './pr-pending-actions'
import { resolvePushRemote } from './pr-push-remote-resolution'
import type { PRChatAction } from './pr-watch-tables'
import { prKeyOf, prWatchCandidate, type PRWatchServiceDeps } from './pr-watch-types'

const ACTION_WINDOW_MS = 14 * 24 * 60 * 60_000
const STARTUP_SPACING_MS = 10_000
const SWEEP_INTERVAL_MS = 60_000

type ChatWatch = { candidate: reads.GitHubPRRefreshCandidate; lastActionAt: number }

export class PRWatchService {
  private readonly chatWatches = new Map<string, ChatWatch>()
  private readonly resume: PRPendingActionResume
  private readonly earlierHeads: PREarlierHeadJobs
  private readonly deliveries: PREventDeliveryTrigger
  private stopObserving: (() => void) | null = null
  private readonly outcomes = new Map<string, Promise<unknown>>()
  private lastSweepAt = 0
  private readonly now: () => number

  constructor(private readonly deps: PRWatchServiceDeps) {
    this.now = deps.now ?? Date.now
    this.resume = new PRPendingActionResume({
      ...deps,
      repositories: async ({ repoPath, connectionId, wslDistro }) =>
        (await resolveGitHubApiRepositoryCandidates(repoPath, connectionId, { wslDistro }))
          .candidates,
      resolvePushRemote,
      readAfterPush: (candidate) => refresh.enqueuePRRefresh(candidate, 'post-push'),
      resolveCommitSha: resolvePRCommitSha,
      isCommitInPRHead,
      settle: (row, indices, verified) => this.settleActions(row, indices, verified),
      now: this.now
    })
    this.earlierHeads = new PREarlierHeadJobs({
      database: deps.database,
      apply: (prKey, headSha, rollup) =>
        this.inOrder(prKey, () => this.applyHeadRead(prKey, headSha, rollup, false)),
      logger: deps.logger,
      now: this.now
    })
    this.deliveries = new PREventDeliveryTrigger(deps)
  }

  async start(): Promise<void> {
    if (this.deps.database.readOnly) {
      return
    }
    this.stopObserving = refresh.addPRRefreshOutcomeObserver((candidate, outcome) => {
      const key = outcome.kind === 'found' ? prKeyOf(outcome.pr) : null
      void this.inOrder(key ?? candidate.cacheKey, () => this.observe(candidate, outcome)).catch(
        this.failed
      )
    })
    refresh.setPRWatchJobHooks({
      isWatched: (job) => this.isWatched(job),
      readHeadChecks: (job, candidate) => this.earlierHeads.read(job, candidate)
    })
    await this.sweepGoneChats(true)
    if (this.stopped) {
      return
    }
    await this.deliveries.load()
    if (this.stopped) {
      return
    }
    const active = await this.deps.database.write({
      kind: 'active',
      now: this.now(),
      windowMs: ACTION_WINDOW_MS
    })
    if (this.stopped) {
      return
    }
    let index = 0
    for (const [prKey, action] of active) {
      await this.watchChatPR(prKey, action, this.now() + STARTUP_SPACING_MS * index++)
      if (this.stopped) {
        return
      }
    }
    for (const [prKey, watch] of this.chatWatches) {
      index = await this.earlierHeads.scheduleMoved(prKey, watch.candidate, index)
      if (this.stopped) {
        return
      }
    }
    await this.deps.database.write({
      kind: 'retire',
      now: this.now(),
      windowMs: ACTION_WINDOW_MS,
      held: [...this.chatWatches.keys()]
    })
    if (this.stopped) {
      return
    }
    this.resume.drain()
  }

  private get stopped(): boolean {
    return this.deps.database.isClosed || !this.stopObserving
  }

  stop(): void {
    this.stopObserving?.()
    this.stopObserving = null
    refresh.setPRWatchJobHooks(null)
    for (const prKey of this.chatWatches.keys()) {
      refresh.cancelPRWatchRead({ prKey })
    }
    this.resume.clear()
    this.earlierHeads.clear()
    this.chatWatches.clear()
  }

  observeCommittedRows(
    chatId: string,
    journal: AgentSessionJournal,
    rows: JournalWriterCommit | undefined
  ): void {
    if (this.deps.database.readOnly) {
      return
    }
    if (finishesPRActionCall(rows)) {
      this.resume.drain()
    }
    this.deliveries.committed(chatId, journal, rows)
  }

  private async settleActions(
    row: PRPendingActionRow,
    indices: number[],
    verified: PRVerifiedAction[]
  ): Promise<void> {
    if (this.stopped) {
      return
    }
    await this.deps.database.write({ kind: 'settle', row, indices, verified })
    if (this.stopped) {
      return
    }
    for (const { action, candidate } of verified) {
      await this.watchChatPR(pullRequestKey(action), action, this.now(), candidate)
    }
  }

  private async watchChatPR(
    prKey: string,
    action: PRChatAction,
    dueAt: number,
    known?: reads.GitHubPRRefreshCandidate
  ): Promise<void> {
    const existing = this.chatWatches.get(prKey)
    let candidate = known ?? existing?.candidate
    if (!candidate) {
      const workspace = await this.deps.chatWorkspace(action.chatId)
      candidate =
        workspace && workspace !== 'not-git'
          ? prWatchCandidate(workspace, action.number)
          : undefined
    }
    if (!candidate || this.stopped) {
      return
    }
    this.chatWatches.set(prKey, {
      candidate,
      lastActionAt: Math.max(existing?.lastActionAt ?? 0, action.observedAt)
    })
    refresh.schedulePRWatchRead({ prKey }, candidate, dueAt)
  }

  private isWatched(job: PRWatchJob): boolean {
    if (job.headSha) {
      return this.earlierHeads.has(job)
    }
    const watch = this.chatWatches.get(job.prKey)
    if (watch && watch.lastActionAt + ACTION_WINDOW_MS <= this.now()) {
      void this.endChatWatch(job.prKey).catch(this.failed)
      return false
    }
    return watch !== undefined
  }

  /** Ending a watch retains its reported results. */
  private async endChatWatch(prKey: string): Promise<void> {
    this.chatWatches.delete(prKey)
    refresh.cancelPRWatchRead({ prKey })
    if (!this.stopped) {
      await this.deps.database.write({ kind: 'end', prKey })
    }
  }

  private activeCandidate(prKey: string): reads.GitHubPRRefreshCandidate | null {
    const watch = this.chatWatches.get(prKey)
    return watch && watch.lastActionAt + ACTION_WINDOW_MS > this.now() ? watch.candidate : null
  }

  private async observe(
    candidate: reads.GitHubPRRefreshCandidate,
    outcome: reads.PRRefreshOutcome
  ): Promise<void> {
    if (this.stopped) {
      return
    }
    if (outcome.kind === 'no-pr') {
      await this.resume.noteNoPR(candidate, outcome.fetchedAt)
    }
    const pr = outcome.kind === 'found' ? outcome.pr : null
    const prKey = pr ? prKeyOf(pr) : null
    if (!pr?.headSha || !prKey || outcome.kind !== 'found') {
      return
    }
    await this.resume.verifyRead(candidate, pr, outcome.fetchedAt)
    if (this.stopped) {
      return
    }
    const active = this.activeCandidate(prKey)
    if (!active) {
      return
    }
    await this.sweepGoneChats(false)
    if (this.stopped) {
      return
    }
    const rollup = observedPRCheckRollup(outcome)
    if (rollup) {
      await this.applyHeadRead(prKey, pr.headSha, rollup, true, outcome.fetchedAt)
      if (this.stopped) {
        return
      }
    }
    await (pr.state === 'merged' || pr.state === 'closed'
      ? this.deps.database.write({ kind: 'delete-moved', prKey })
      : this.earlierHeads.scheduleMoved(prKey, active))
    if (this.stopped) {
      return
    }
    if (prWatchSettled(pr)) {
      await this.endChatWatch(prKey)
      return
    }
    const nextDueAt = prWatchNextDueAt(outcome)
    if (nextDueAt !== null) {
      refresh.schedulePRWatchRead({ prKey }, active, nextDueAt, { defer: true })
    }
  }

  private async applyHeadRead(
    prKey: string,
    headSha: string,
    rollup: readonly unknown[],
    isCurrentHead: boolean,
    observedAt = this.now()
  ): Promise<boolean> {
    if (this.stopped) {
      return false
    }
    const written = await this.deps.database.write({
      kind: 'head',
      read: {
        prKey,
        headSha,
        rollup,
        isCurrentHead,
        observedAt
      }
    })
    if (this.stopped) {
      return written.final
    }
    for (const chatId of written.chatIds) {
      this.deliveries.owe(chatId, this.deps.openJournal(chatId))
    }
    return written.final
  }

  private async sweepGoneChats(force: boolean): Promise<void> {
    if (!force && this.now() - this.lastSweepAt < SWEEP_INTERVAL_MS) {
      return
    }
    this.lastSweepAt = this.now()
    await sweepGonePRChats(
      this.deps,
      () => this.stopped,
      this.chatWatches.keys(),
      (id) => this.deliveries.forget(id),
      (key) => this.endChatWatch(key)
    )
  }
  private readonly failed = (error: unknown): void => {
    this.deps.logger.warn('updating CI-line watches failed', { scope: 'pr-watch', error })
  }

  private inOrder<T>(prKey: string, run: () => Promise<T>): Promise<T> {
    return orderPRWatchOutcome(this.outcomes, prKey, run)
  }
}
