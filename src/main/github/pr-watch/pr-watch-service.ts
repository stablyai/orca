// The host's CI-line service: chats' verified PR actions start watches the pr-refresh queue reads;
// each new final result on a head becomes one line in every chat that owned the PR when it landed.

import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../shared/github/pull-request-refresh-types'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import { pullRequestKey } from '../../../shared/native-chat/native-chat-pull-request-event'
import type { JournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import { resolveGitHubApiRepositoryCandidates } from '../github-api-repository'
import { observedPRCheckRollup } from '../client/lookup/pr-refresh-outcome-assembly'
import {
  addPRRefreshOutcomeObserver,
  cancelPRWatchRead,
  enqueuePRRefresh,
  schedulePRWatchRead,
  setPRWatchJobHooks
} from '../pr-refresh-coordinator'
import { prChecksDone, prWatchNextDueAt, type PRWatchJob } from '../pr-refresh-watch-jobs'
import { finishedShellCalls, PRChatActionRecorder } from './pr-chat-action-recorder'
import { PRReplayedHeads, replayCrashWindow } from './pr-chat-call-replay'
import { deletePRMovedHeads, endPRWatchState } from './pr-check-event-tables'
import { PREarlierHeadJobs } from './pr-earlier-head-jobs'
import { PREventDeliveryTrigger } from './pr-event-delivery'
import { resolvePRCommitSha } from './pr-head-check-read'
import {
  activeSavedPRWatches,
  recordPRChatAction,
  recordPRHeadObservation
} from './pr-head-evaluation'
import {
  isPRFollowUpJob,
  prFollowUpCandidate,
  publishPRObservation,
  resolvePRFollowUp
} from './pr-watch-seams'
import {
  hasPRChatActionFrom,
  hasPRChatActions,
  sweepGonePRWatchChats,
  type PRChatAction
} from './pr-watch-tables'
import {
  prKeyOf,
  prObservationOf,
  prWatchCandidate,
  type PRWatchServiceDeps
} from './pr-watch-types'

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
  private readonly reconciled = new Set<string>()
  private readonly replayedHeads = new PRReplayedHeads()
  private startedAt = Number.POSITIVE_INFINITY
  private readonly recorder: PRChatActionRecorder
  private readonly earlierHeads: PREarlierHeadJobs
  private readonly deliveries: PREventDeliveryTrigger
  private stopObserving: (() => void) | null = null
  private lastSweepAt = 0
  private readonly now: () => number

  constructor(private readonly deps: PRWatchServiceDeps) {
    this.now = deps.now ?? Date.now
    this.recorder = new PRChatActionRecorder({
      chatWorkspace: deps.chatWorkspace,
      isRecorded: (chatId, anchorItemId) =>
        hasPRChatActionFrom(this.deps.database.db, chatId, anchorItemId),
      repositories: async ({ repoPath, connectionId, wslDistro }) =>
        (await resolveGitHubApiRepositoryCandidates(repoPath, connectionId, { wslDistro }))
          .candidates,
      readAfterPush: (candidate) => enqueuePRRefresh(candidate, 'post-push'),
      resolveCommitSha: resolvePRCommitSha,
      record: (action, candidate, how) => this.recordAction(action, candidate, how),
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
    this.startedAt = this.now()
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
    }
    for (const [prKey, watch] of this.chatWatches) {
      index = this.earlierHeads.scheduleMoved(prKey, watch.candidate, index)
    }
  }

  stop(): void {
    this.stopObserving?.()
    this.stopObserving = null
    setPRWatchJobHooks(null)
    for (const prKey of this.chatWatches.keys()) {
      cancelPRWatchRead({ prKey })
    }
    this.recorder.clear()
    this.earlierHeads.clear()
    this.chatWatches.clear()
    this.reconciled.clear()
    this.replayedHeads.clear()
  }

  /** Each committed batch: finished calls may be PR actions, and the chat may take its lines now. */
  observeCommittedRows(
    chatId: string,
    journal: AgentSessionJournal,
    rows: readonly JournalRow[] | undefined
  ): void {
    if (this.deps.database.readOnly) {
      return
    }
    if (!rows) {
      this.reconcileChat(chatId, journal)
    }
    const calls = rows ? finishedShellCalls(chatId, rows) : []
    if (calls.length > 0) {
      void this.recorder.record(calls).catch((error: unknown) =>
        this.deps.logger.warn('recording pull request actions failed', {
          scope: 'pr-watch',
          chatId,
          error
        })
      )
    }
    this.deliveries.committed(chatId, journal)
  }

  /** Recovers the crash window once per chat per start; retryable at the next open if it fails. */
  reconcileChat(chatId: string, journal: AgentSessionJournal): void {
    if (this.reconciled.has(chatId) || this.deps.database.readOnly) {
      return
    }
    this.reconciled.add(chatId)
    void replayCrashWindow({
      db: this.deps.database.db,
      journal: { sessionId: chatId, physicalCursor: journal.physicalCursor, item: journal.item },
      startedAt: this.startedAt,
      record: (calls) => this.recorder.record(calls, true)
    }).then(
      (complete) => complete || this.reconciled.delete(chatId),
      (error: unknown) => {
        this.reconciled.delete(chatId)
        this.deps.logger.warn('replaying pull request actions failed', {
          scope: 'pr-watch',
          chatId,
          error
        })
      }
    )
  }

  private recordAction(
    action: PRChatAction,
    candidate: GitHubPRRefreshCandidate,
    how: { superseded: boolean; replayed: boolean }
  ): void {
    recordPRChatAction(this.deps.database, action, how.superseded ? this.now() : null)
    if (how.replayed) {
      this.replayedHeads.mark(pullRequestKey(action), action.headSha)
    }
    void this.watchChatPR(pullRequestKey(action), action, this.now(), candidate)
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
      candidate = workspace ? prWatchCandidate(workspace, action.number) : undefined
    }
    if (!candidate) {
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
    if (isPRFollowUpJob(job)) {
      return true
    }
    const watch = this.chatWatches.get(job.prKey)
    if (watch && watch.lastActionAt + ACTION_WINDOW_MS <= this.now()) {
      this.endChatWatch(job.prKey)
      return isPRFollowUpJob(job)
    }
    return watch !== undefined
  }

  /** Earlier heads stop; context memory stays with the PR's actions, so a later watch of the same
   *  results (after a restart or a new action) never reports them again. */
  private endChatWatch(prKey: string): void {
    this.chatWatches.delete(prKey)
    if (!isPRFollowUpJob({ prKey })) {
      cancelPRWatchRead({ prKey })
    }
    this.deps.database.transaction((db) => endPRWatchState(db, prKey))
  }

  /** A recent chat action, or a follow-up registration that resolved to this PR. */
  private activeCandidate(prKey: string): GitHubPRRefreshCandidate | null {
    const watch = this.chatWatches.get(prKey)
    if (watch && watch.lastActionAt + ACTION_WINDOW_MS > this.now()) {
      return watch.candidate
    }
    return prFollowUpCandidate(prKey)
  }

  /** One subscriber, in order: a read may verify a push before it is evaluated for lines. */
  private observe(candidate: GitHubPRRefreshCandidate, outcome: PRRefreshOutcome): void {
    const pr = outcome.kind === 'found' ? outcome.pr : null
    const prKey = pr ? prKeyOf(pr) : null
    if (!pr?.headSha || !prKey || outcome.kind !== 'found') {
      return
    }
    this.recorder.verify(candidate, pr, outcome.fetchedAt)
    publishPRObservation(prObservationOf(pr, prKey, outcome.fetchedAt), (error) =>
      this.deps.logger.warn('a pull request observer failed', { scope: 'pr-watch', prKey, error })
    )
    const resolved = resolvePRFollowUp(candidate, prKey)
    if (resolved) {
      // One job per resolved PR serves every reason, so a chat and a follow-up never read it twice.
      schedulePRWatchRead({ prKey }, resolved, this.now())
    }
    const active = this.activeCandidate(prKey)
    if (!active) {
      return
    }
    this.sweepGoneChats(false)
    const rollup = observedPRCheckRollup(outcome)
    // A follow-up keeps an older owner's lines coming; with no owner there is nothing to write.
    if (rollup && (this.chatWatches.has(prKey) || hasPRChatActions(this.deps.database.db, prKey))) {
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
    const nextDueAt = prWatchNextDueAt(outcome)
    if (nextDueAt !== null) {
      schedulePRWatchRead({ prKey }, active, nextDueAt, { defer: true })
    }
  }

  private applyHeadRead(
    prKey: string,
    headSha: string,
    rollup: readonly unknown[],
    isCurrentHead: boolean,
    observedAt = this.now()
  ): boolean {
    const silent = this.replayedHeads.takeFirstRead(prKey, headSha, isCurrentHead)
    const written = recordPRHeadObservation(this.deps.database, {
      prKey,
      headSha,
      rollup,
      isCurrentHead,
      observedAt,
      silent
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
