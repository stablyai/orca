// Whether a chat conversation's orchestration workers still run, so its connector shows it working
// after the turn that started them ends.
import type { ConversationEvent, ConversationEventsDeps } from './external-conversation-events'
import { CONNECTOR_CLIENT_LIMITS } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { ConversationWorkerAnswer } from './external-conversation-worker-activities'
import type { LinkedConversation } from './external-conversation-links'
import { conversationPane, type ConversationPane } from './external-conversation-types'
import {
  installedConversationWorkersWatcher,
  type ConversationWorkerActivity,
  type ConversationWorkersRead,
  type ConversationWorkersWatcher,
  type ConversationWorkerView
} from './external-conversation-worker-view'

export type { ConversationWorkerActivity, ConversationWorkersRead, ConversationWorkerView }
export {
  conversationWorkerActivities,
  type ConversationWorkerAnswer,
  type ConversationWorkersHost
} from './external-conversation-worker-activities'

// While some run, how often their end is looked for.
export const CONVERSATION_WORKERS_POLL_MS = 10_000
// A worker that never settles cannot keep a conversation working past this after the bot's last turn.
export const CONVERSATION_WORKERS_MAX_RUNNING_MS = 6 * 60 * 60 * 1000
// Lost contact is no exit, but a host that never answers again cannot hold the conversation either.
export const CONVERSATION_WORKERS_MAX_UNVERIFIABLE_MS = 15 * 60 * 1000

type Tracked = {
  pane: ConversationPane
  running: boolean
  activity: ConversationWorkerActivity
  helpersRunning: boolean
  // An idle worker is read on: it resumes without a turn of this conversation's.
  open: boolean
  // The bot's last turn end, or the first read when none was seen; bounds a running state.
  since: number
  unverifiableSince: number | null
  lastTurnId: number | null
}

export type ConversationWorkersDeps = Pick<ConversationEventsDeps, 'setTimer' | 'now'> & {
  /** What the workers each of these chat conversations started are doing, by session id, in one
   *  read; null where none can be read. */
  workerActivities: (
    links: readonly ExternalConversationLink[]
  ) => Promise<ReadonlyMap<string, ConversationWorkerAnswer> | null>
  linkedFor: (paneKey: string) => LinkedConversation | null
  emit: (event: ConversationEvent) => void
  /** The installed watcher when absent. */
  workersWatcher?: ConversationWorkersWatcher
}

/** A pane's checks waiting for the next read; each resolves once a read begun after it applies. */
type PendingCheck = {
  reasons: Set<ConversationWorkersRead>
  settled: (() => void)[]
  // The ended turn a `turn-ended` check is for; undefined when none named one.
  turnId?: number | null
}

/**
 * Tells a `workers` event whenever a chat conversation's running state changes. Checks wait for one
 * read of every conversation asked about, and one read runs at a time, so a poll of many
 * conversations is a single read off the runtime's thread rather than one per conversation.
 */
export class ConversationWorkers {
  private readonly tracked = new Map<string, Tracked>()
  // Read before, or being read now.
  private readonly known = new Set<string>()
  private pending = new Map<string, PendingCheck>()
  // A read is queued or in flight; checks made meanwhile join the next one.
  private reading = false
  private poll: { cancel: () => void } | null = null
  // A clear outdates reads still in flight.
  private generation = 0

  constructor(private readonly deps: ConversationWorkersDeps) {}

  // A watcher that throws never stops this read's other panes from applying.
  private tell(call: (watcher: ConversationWorkersWatcher) => void): void {
    const watcher = this.deps.workersWatcher ?? installedConversationWorkersWatcher()
    try {
      if (watcher) {
        call(watcher)
      }
    } catch (error) {
      console.warn('[connector] a workers watcher threw', error)
    }
  }

  /** Undefined before its first read. */
  runningOf(paneKey: string): boolean | undefined {
    return this.tracked.get(paneKey)?.running
  }

  /** A snapshot entry's workers field, absent before the first read. */
  snapshotOf(paneKey: string): { workersRunning?: boolean } {
    const running = this.runningOf(paneKey)
    return running === undefined ? {} : { workersRunning: running }
  }

  /** Read before, or being read now. */
  isKnown(paneKey: string): boolean {
    return this.known.has(paneKey)
  }

  /** Undefined before its first read. */
  viewOf(paneKey: string): ConversationWorkerView | undefined {
    const tracked = this.tracked.get(paneKey)
    return tracked && viewOf(tracked)
  }

  /** A pane's turn just ended; its `turn-ended` check follows once its answer is read. */
  turnEnding(paneKey: string): void {
    this.tell((watcher) => watcher.turnEnding?.(paneKey))
  }

  /** `turnId`: the ended turn a `turn-ended` check is for. */
  check(paneKey: string, reason: ConversationWorkersRead, turnId?: number | null): Promise<void> {
    if (!this.deps.linkedFor(paneKey)) {
      this.forget(paneKey)
      return Promise.resolve()
    }
    this.known.add(paneKey)
    return new Promise((resolve) => {
      const entry = this.pending.get(paneKey) ?? { reasons: new Set(), settled: [] }
      entry.reasons.add(reason)
      entry.settled.push(resolve)
      if (reason === 'turn-ended' && turnId !== undefined) {
        entry.turnId = turnId
      }
      this.pending.set(paneKey, entry)
      if (!this.reading) {
        this.reading = true
        // Checks made in the same turn, as a poll's, share one read.
        queueMicrotask(() => void this.readPending())
      }
    })
  }

  private async readPending(): Promise<void> {
    while (this.pending.size > 0) {
      const batch = this.pending
      this.pending = new Map()
      try {
        await this.read(batch)
      } catch (error) {
        // One failed apply must not wedge every later check behind it.
        console.warn('[connector] could not apply conversations’ workers', error)
        for (const entry of batch.values()) {
          settle(entry)
        }
        this.schedule()
      }
    }
    this.reading = false
  }

  private async read(batch: Map<string, PendingCheck>): Promise<void> {
    const { generation } = this
    const linked = new Map<string, LinkedConversation>()
    for (const paneKey of batch.keys()) {
      const conversation = this.deps.linkedFor(paneKey)
      if (conversation) {
        linked.set(paneKey, conversation)
      } else {
        this.forget(paneKey)
      }
    }
    let activities: ReadonlyMap<string, ConversationWorkerAnswer> | null | undefined
    try {
      activities =
        linked.size > 0
          ? await this.deps.workerActivities([...linked.values()].map(({ link }) => link))
          : null
    } catch (error) {
      console.warn('[connector] could not read conversations’ workers', error)
      activities = undefined
    }
    for (const [paneKey, entry] of batch) {
      const conversation = linked.get(paneKey)
      const newer = this.pending.get(paneKey)
      if (generation !== this.generation || !conversation) {
        settle(entry)
      } else if (newer) {
        // Only a pane's newest read applies; it keeps what this one was asked for.
        for (const reason of entry.reasons) {
          newer.reasons.add(reason)
        }
        newer.settled.push(...entry.settled)
        if (newer.turnId === undefined && entry.turnId !== undefined) {
          newer.turnId = entry.turnId
        }
      } else {
        const answer =
          activities === undefined
            ? 'unread'
            : (activities?.get(conversation.link.sessionId) ?? null)
        const read =
          answer === 'unread'
            ? {
                activity: this.unreadActivity(paneKey),
                helpersRunning: this.tracked.get(paneKey)?.helpersRunning ?? false
              }
            : answer
        if (read !== null) {
          this.apply(paneKey, conversation, read, entry)
        }
        settle(entry)
      }
    }
    this.schedule()
  }

  // An unread answer is no exit: a running state stays, under the out-of-contact bound.
  private unreadActivity(paneKey: string): ConversationWorkerActivity {
    const known = this.tracked.get(paneKey)
    return known?.running ? 'unverifiable' : known?.open ? 'idle' : 'none'
  }

  private apply(
    paneKey: string,
    linked: LinkedConversation,
    { activity, helpersRunning }: Exclude<ConversationWorkerAnswer, 'unread'>,
    { reasons, turnId }: PendingCheck
  ): void {
    const now = this.deps.now()
    const prior = this.tracked.get(paneKey)
    const since = reasons.has('turn-ended') || !prior ? now : prior.since
    const unverifiableSince = activity === 'unverifiable' ? (prior?.unverifiableSince ?? now) : null
    const open =
      activity !== 'none' &&
      now - since < CONVERSATION_WORKERS_MAX_RUNNING_MS &&
      (unverifiableSince === null ||
        now - unverifiableSince < CONVERSATION_WORKERS_MAX_UNVERIFIABLE_MS)
    const running = open && activity !== 'idle'
    const pane = conversationPane(linked.link, linked.workspace.worktreeId)
    const tracked: Tracked = {
      pane,
      running,
      activity,
      helpersRunning,
      open,
      since,
      unverifiableSince,
      lastTurnId: turnId !== undefined ? turnId : (prior?.lastTurnId ?? null)
    }
    this.tracked.set(paneKey, tracked)
    const told = prior ? prior.running : reasons.has('watch') ? undefined : false
    if (running !== told) {
      this.deps.emit({ kind: 'workers', ...pane, running })
    }
    this.tell((watcher) => watcher.applied(paneKey, viewOf(tracked), reasons))
  }

  // An unlinked conversation's workers no longer hold it.
  private forget(paneKey: string): void {
    const tracked = this.tracked.get(paneKey)
    this.tracked.delete(paneKey)
    if (tracked?.running) {
      this.deps.emit({ kind: 'workers', ...tracked.pane, running: false })
    }
    if (tracked) {
      this.tell((watcher) => watcher.forgotten(paneKey))
    }
  }

  /** Recent chats' workers, each once: a restart may have outlived or missed their end. */
  watched(conversations: readonly { paneKey: string; activeAt: number }[]): void {
    const since = this.deps.now() - CONNECTOR_CLIENT_LIMITS.snapshotActiveWindowMs
    for (const { paneKey, activeAt } of conversations) {
      if (activeAt >= since && !this.isKnown(paneKey)) {
        void this.check(paneKey, 'watch')
      }
    }
    this.tell((watcher) => watcher.watched())
  }

  clear(): void {
    this.generation++
    this.poll?.cancel()
    this.poll = null
    this.tracked.clear()
    this.known.clear()
    for (const entry of this.pending.values()) {
      settle(entry)
    }
    this.pending.clear()
    this.tell((watcher) => watcher.cleared())
  }

  // Only conversations with open workers are polled; one without is read again at its next turn end.
  private schedule(): void {
    if (this.poll || this.openPanes().length === 0) {
      return
    }
    this.poll = this.deps.setTimer(() => {
      this.poll = null
      for (const paneKey of this.openPanes()) {
        void this.check(paneKey, 'poll')
      }
    }, CONVERSATION_WORKERS_POLL_MS)
  }

  private openPanes(): string[] {
    return [...this.tracked].flatMap(([paneKey, tracked]) => (tracked.open ? [paneKey] : []))
  }
}

function viewOf(tracked: Tracked): ConversationWorkerView {
  const { activity, open, helpersRunning, since, unverifiableSince, lastTurnId } = tracked
  return { activity, open, helpersRunning, since, unverifiableSince, lastTurnId }
}

function settle(entry: PendingCheck): void {
  for (const resolve of entry.settled) {
    resolve()
  }
}
