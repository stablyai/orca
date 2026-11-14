// The host's CI-line service: chats' verified PR actions start watches the pr-refresh queue reads;
// each new final result on a head becomes one line in every chat that owned the PR when it landed.

import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRInfo } from '../../../shared/github/pull-requests/pull-request-types'
import { pullRequestKey } from '../../../shared/native-chat/native-chat-pull-request-event'
import type { JournalRow } from '../../native-chat/agent-session-journal/durable-rows/journal-row-schema'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { resolveGitHubApiRepositoryCandidates } from '../repositories/github-api-repository'
import { observedPRCheckRollup } from '../client/lookup/pr-refresh-outcome-assembly'
import {
  addPRRefreshOutcomeObserver,
  cancelPRWatchRead,
  enqueuePRRefresh,
  schedulePRWatchRead,
  setPRWatchJobHooks
} from '../pull-requests/refresh/pr-refresh-coordinator'
import {
  prChecksDone,
  prWatchPlanDueAt,
  prWatchReadPlan,
  type PRWatchJob
} from '../pull-requests/refresh/pr-refresh-watch-jobs'
import { deletePRMovedHeads, endPRWatchState } from './pr-check-event-tables'
import { PREarlierHeadJobs } from './pr-earlier-head-jobs'
import { PREventDeliveryTrigger } from './pr-event-delivery'
import { isCommitInPRHead, resolvePRCommitSha } from './pr-head-check-read'
import {
  activeSavedPRWatches,
  recordPRHeadObservation,
  retireInactiveCurrentPRHeads,
  settlePRPendingObligations
} from './pr-head-evaluation'
import { PRPendingActionResume } from './pr-pending-action-resume'
import type { PRVerifiedAction } from './pr-pending-action-types'
import { finishesPRActionCall, type PRPendingActionRow } from './pr-pending-actions'
import { resolvePushRemote } from './pr-push-remote-resolution'
import { sweepGonePRWatchChats, type PRChatAction } from './pr-watch-tables'
import { prKeyOf, prWatchCandidate, type PRWatchServiceDeps } from './pr-watch-types'

const ACTION_WINDOW_MS = 14 * 24 * 60 * 60_000
const STARTUP_SPACING_MS = 10_000
const SWEEP_INTERVAL_MS = 60_000

type ChatWatch = { candidate: GitHubPRRefreshCandidate; lastActionAt: number }

/** A merged or closed PR whose checks are done (final, or none on a complete read) reports nothing
 *  more; a failure beside a running check, an approval blocker or a partial read is not done. */
function settled(pr: PRInfo): boolean {
  return (pr.state === 'merged' || pr.state === 'closed') && prChecksDone(pr)
}

export class PRWatchService {
  private readonly chatWatches = new Map<string, ChatWatch>()
  private readonly resume: PRPendingActionResume
  private readonly earlierHeads: PREarlierHeadJobs
  private readonly deliveries: PREventDeliveryTrigger
  private stopObserving: (() => void) | null = null
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
      readAfterPush: (candidate) => enqueuePRRefresh(candidate, 'post-push'),
      resolveCommitSha: resolvePRCommitSha,
      isCommitInPRHead,
      settle: (row, indices, verified) => this.settleActions(row, indices, verified),
      now: this.now
    })
    this.earlierHeads = new PREarlierHeadJobs({
      database: deps.database,
      apply: (prKey, headSha, rollup) => this.applyHeadRead(prKey, headSha, rollup, false),
      logger: deps.logger,
      now: this.now
    })
    this.deliveries = new PREventDeliveryTrigger(deps)
  }

  async start(): Promise<void> {
    if (this.deps.database.readOnly) {
      return
    }
    this.stopObserving = addPRRefreshOutcomeObserver((candidate, outcome) =>
      this.observe(candidate, outcome)
    )
    setPRWatchJobHooks({
      isWatched: (job) => this.isWatched(job),
      readHeadChecks: (job, candidate) => this.earlierHeads.read(job, candidate)
    })
    this.sweepGoneChats(true)
    this.deliveries.load()
    const active = activeSavedPRWatches(this.deps.database, this.now(), ACTION_WINDOW_MS)
    // Spaced as the queue would space them anyway, so a restart starts no burst.
    let index = 0
    for (const [prKey, action] of active) {
      await this.watchChatPR(prKey, action, this.now() + STARTUP_SPACING_MS * index++)
      // Stopped, or its database closed, while a workspace was resolving: nothing more to start.
      if (this.stopped) {
        return
      }
    }
    for (const [prKey, watch] of this.chatWatches) {
      index = this.earlierHeads.scheduleMoved(prKey, watch.candidate, index)
    }
    // Committed rows may have resumed and saved actions while startup waited; they hold their heads.
    retireInactiveCurrentPRHeads(
      this.deps.database,
      this.now(),
      ACTION_WINDOW_MS,
      this.chatWatches.keys()
    )
    this.resume.drain()
  }

  private get stopped(): boolean {
    return this.deps.database.isClosed || !this.stopObserving
  }

  stop(): void {
    this.stopObserving?.()
    this.stopObserving = null
    setPRWatchJobHooks(null)
    for (const prKey of this.chatWatches.keys()) {
      cancelPRWatchRead({ prKey })
    }
    this.resume.clear()
    this.earlierHeads.clear()
    this.chatWatches.clear()
  }

  /** Each committed batch: a finished call's obligations were captured with it; resume them now. */
  observeCommittedRows(
    chatId: string,
    journal: AgentSessionJournal,
    rows: readonly JournalRow[] | undefined
  ): void {
    if (this.deps.database.readOnly) {
      return
    }
    if (rows && finishesPRActionCall(rows)) {
      this.resume.drain()
    }
    this.deliveries.committed(chatId, journal)
  }

  private settleActions(
    row: PRPendingActionRow,
    indices: number[],
    verified: PRVerifiedAction[]
  ): void {
    settlePRPendingObligations(this.deps.database, row, indices, verified)
    for (const { action, candidate } of verified) {
      void this.watchChatPR(pullRequestKey(action), action, this.now(), candidate)
    }
  }

  /** A known candidate starts the watch synchronously, before the read that verified it is evaluated. */
  private async watchChatPR(
    prKey: string,
    action: PRChatAction,
    dueAt: number,
    known?: GitHubPRRefreshCandidate
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
    // A workspace that resolved after the service stopped starts nothing.
    if (!candidate || this.stopped) {
      return
    }
    this.chatWatches.set(prKey, {
      candidate,
      lastActionAt: Math.max(existing?.lastActionAt ?? 0, action.observedAt)
    })
    schedulePRWatchRead({ prKey }, candidate, dueAt)
  }

  private isWatched(job: PRWatchJob): boolean {
    if (job.headSha) {
      return this.earlierHeads.has(job)
    }
    const watch = this.chatWatches.get(job.prKey)
    if (watch && watch.lastActionAt + ACTION_WINDOW_MS <= this.now()) {
      this.endChatWatch(job.prKey)
      return false
    }
    return watch !== undefined
  }

  /** Earlier heads stop; context memory stays with the PR's actions, so a later watch of the same
   *  results (after a restart or a new action) never reports them again. */
  private endChatWatch(prKey: string): void {
    this.chatWatches.delete(prKey)
    cancelPRWatchRead({ prKey })
    this.deps.database.transaction((db) => endPRWatchState(db, prKey))
  }

  /** The PR's chat watch while a recent action holds it. */
  private activeCandidate(prKey: string): GitHubPRRefreshCandidate | null {
    const watch = this.chatWatches.get(prKey)
    return watch && watch.lastActionAt + ACTION_WINDOW_MS > this.now() ? watch.candidate : null
  }

  /** One subscriber, in order: a read may verify a push before it is evaluated for lines. */
  private observe(candidate: GitHubPRRefreshCandidate, outcome: PRRefreshOutcome): void {
    if (outcome.kind === 'no-pr') {
      this.resume.noteNoPR(candidate, outcome.fetchedAt)
    }
    const pr = outcome.kind === 'found' ? outcome.pr : null
    const prKey = pr ? prKeyOf(pr) : null
    if (!pr?.headSha || !prKey || outcome.kind !== 'found') {
      return
    }
    this.resume.verifyRead(candidate, pr, outcome.fetchedAt)
    const active = this.activeCandidate(prKey)
    if (!active) {
      return
    }
    this.sweepGoneChats(false)
    const rollup = observedPRCheckRollup(outcome)
    if (rollup) {
      this.applyHeadRead(prKey, pr.headSha, rollup, true, outcome.fetchedAt)
    }
    if (pr.state === 'merged' || pr.state === 'closed') {
      this.deps.database.transaction((db) => deletePRMovedHeads(db, prKey))
    } else {
      this.earlierHeads.scheduleMoved(prKey, active)
    }
    if (settled(pr)) {
      this.endChatWatch(prKey)
      return
    }
    // Any read of the PR, a sidebar's included, serves the watch's next due read.
    const plan = prWatchReadPlan(outcome)
    const nextDueAt = plan && prWatchPlanDueAt(plan)
    if (plan && nextDueAt !== null) {
      schedulePRWatchRead({ prKey }, active, nextDueAt, { defer: true, plan })
    }
  }

  private applyHeadRead(
    prKey: string,
    headSha: string,
    rollup: readonly unknown[],
    isCurrentHead: boolean,
    observedAt = this.now()
  ): boolean {
    const written = recordPRHeadObservation(this.deps.database, {
      prKey,
      headSha,
      rollup,
      isCurrentHead,
      observedAt
    })
    for (const chatId of written.chatIds) {
      this.deliveries.owe(chatId, this.deps.openJournal(chatId))
    }
    return written.final
  }

  /** A gone chat takes its actions and lines; a PR no chat owns any more stops being read. */
  private sweepGoneChats(force: boolean): void {
    if (!force && this.now() - this.lastSweepAt < SWEEP_INTERVAL_MS) {
      return
    }
    this.lastSweepAt = this.now()
    const { gone, owned } = sweepGonePRWatchChats(this.deps.database, this.deps.chatExists)
    gone.forEach((chatId) => this.deliveries.forget(chatId))
    for (const prKey of this.chatWatches.keys()) {
      if (!owned.has(prKey)) {
        this.endChatWatch(prKey)
      }
    }
  }
}
