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
import { prWatchNextDueAt, type PRWatchJob } from '../pr-refresh-watch-jobs'
import { finishedShellCalls, PRChatActionRecorder } from './pr-chat-action-recorder'
import { deletePRMovedHeads, endPRWatchState } from './pr-check-event-tables'
import { PREarlierHeadJobs } from './pr-earlier-head-jobs'
import { PREventDeliveryTrigger } from './pr-event-delivery'
import { recordPRChatAction, recordPRHeadObservation } from './pr-head-evaluation'
import { isPRFollowUpJob, publishPRObservation } from './pr-watch-seams'
import {
  deletePRWatchChats,
  readPRChatActions,
  readPRWatchChatIds,
  type PRChatAction
} from './pr-watch-tables'
import {
  prKeyOf,
  prObservationOf,
  prWatchCandidate,
  type PRChatActionRecord,
  type PRWatchServiceDeps
} from './pr-watch-types'

const ACTION_WINDOW_MS = 14 * 24 * 60 * 60_000
const STARTUP_SPACING_MS = 10_000
const SWEEP_INTERVAL_MS = 60_000

type ChatWatch = { candidate: GitHubPRRefreshCandidate; lastActionAt: number }

/** A merged PR, or a closed one with nothing left running, reports nothing more. */
function settled(pr: PRInfo): boolean {
  return (pr.state === 'merged' || pr.state === 'closed') && pr.checksStatus !== 'pending'
}

export class PRWatchService {
  private readonly chatWatches = new Map<string, ChatWatch>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
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
      repositories: async ({ repoPath, connectionId, wslDistro }) =>
        (await resolveGitHubApiRepositoryCandidates(repoPath, connectionId, { wslDistro }))
          .candidates,
      readAfterPush: (candidate) => enqueuePRRefresh(candidate, 'post-push'),
      record: (action, candidate) => this.recordAction(action, candidate),
      later: (run, delayMs) => this.later(run, delayMs),
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

  private get db() {
    return this.deps.database.db
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
    const newest = new Map<string, PRChatAction>()
    for (const action of readPRChatActions(this.db)) {
      newest.set(pullRequestKey(action), action)
    }
    // Spaced as the queue would space them anyway, so a restart starts no burst.
    let index = 0
    for (const [prKey, action] of newest) {
      if (action.observedAt + ACTION_WINDOW_MS > this.now()) {
        await this.watchChatPR(prKey, action, this.now() + STARTUP_SPACING_MS * index++)
      }
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
    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.recorder.clear()
    this.earlierHeads.clear()
    this.chatWatches.clear()
    this.timers.clear()
  }

  pullRequestActionsFor(prKey: string): PRChatActionRecord[] {
    if (this.deps.database.isClosed) {
      return []
    }
    return readPRChatActions(this.db, prKey).map(
      ({ chatId, kind, anchor, headSha, observedAt }) => ({
        chatId,
        kind,
        anchor,
        headSha,
        observedAt
      })
    )
  }

  ownerChatFor(prKey: string): string | null {
    const actions = this.pullRequestActionsFor(prKey)
    const newest = (kind: PRChatActionRecord['kind']) =>
      actions.findLast((action) => action.kind === kind)?.chatId
    return newest('pushed') ?? newest('opened') ?? null
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
    const calls = rows ? finishedShellCalls(chatId, rows) : []
    if (calls.length > 0) {
      void this.recorder
        .record(calls)
        .catch((error: unknown) =>
          this.deps.logger.warn('recording pull request actions failed', {
            scope: 'pr-watch',
            chatId,
            error
          })
        )
    }
    this.deliveries.committed(chatId, journal)
  }

  private recordAction(action: PRChatAction, candidate: GitHubPRRefreshCandidate): void {
    recordPRChatAction(this.deps.database, action)
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
      return false
    }
    return watch !== undefined
  }

  private endChatWatch(prKey: string): void {
    this.chatWatches.delete(prKey)
    cancelPRWatchRead({ prKey })
    this.deps.database.transaction((db) => endPRWatchState(db, prKey))
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
    const watch = this.chatWatches.get(prKey)
    if (!watch) {
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
      this.earlierHeads.scheduleMoved(prKey, watch.candidate)
    }
    if (settled(pr)) {
      this.endChatWatch(prKey)
      return
    }
    // Any read of the PR, a sidebar's included, serves the watch's next due read.
    const nextDueAt = prWatchNextDueAt(outcome)
    if (nextDueAt !== null) {
      schedulePRWatchRead({ prKey }, watch.candidate, nextDueAt, { defer: true })
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
    const gone = readPRWatchChatIds(this.db).filter((chatId) => !this.deps.chatExists(chatId))
    if (gone.length === 0) {
      return
    }
    this.deps.database.transaction((db) => deletePRWatchChats(db, gone))
    for (const chatId of gone) {
      this.deliveries.forget(chatId)
    }
    const owned = new Set(readPRChatActions(this.db).map((action) => pullRequestKey(action)))
    for (const prKey of this.chatWatches.keys()) {
      if (!owned.has(prKey)) {
        this.endChatWatch(prKey)
      }
    }
  }

  private later(run: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      run()
    }, delayMs)
    timer.unref?.()
    this.timers.add(timer)
  }
}
