// Whether a chat conversation's orchestration workers still run, so its connector shows it working
// after the turn that started them ends.
import type { ConversationEvent, ConversationEventsDeps } from './external-conversation-events'
import { CONNECTOR_CLIENT_LIMITS } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import {
  sessionWorkerIsRunning,
  sessionWorkerIsWorking,
  type OrchestrationSessionWorker
} from '../../shared/orchestration-session-workers'
import type { ConversationBots } from './external-conversation-bots'
import type { LinkedConversation } from './external-conversation-links'
import { conversationPane, type ConversationPane } from './external-conversation-types'

/** What the chat's workers are doing, by the execution host's verdict; `idle` when every open one
 *  waits (on its coordinator or an answer), `none` when none is open. */
export type ConversationWorkerActivity = 'working' | 'unverifiable' | 'idle' | 'none'

export type ConversationWorkersHost = {
  /** The workers a chat started, as its orchestration records and their hosts tell them. */
  read: (
    sessionId: string
  ) => Promise<
    readonly Pick<OrchestrationSessionWorker, 'state' | 'activity' | 'pendingQuestion'>[]
  >
}

/** A paused or removed bot's workers no longer hold its conversation; null where none can be read. */
export async function conversationWorkerActivity(
  host: { workers?: ConversationWorkersHost; bots?: ConversationBots },
  link: ExternalConversationLink
): Promise<ConversationWorkerActivity | null> {
  if (!host.workers) {
    return null
  }
  if (link.bot && host.bots?.refusal(link.bot.botId)) {
    return 'none'
  }
  const running = (await host.workers.read(link.sessionId)).filter(sessionWorkerIsRunning)
  return running.some(sessionWorkerIsWorking)
    ? 'working'
    : running.some((worker) => worker.state === 'unverifiable')
      ? 'unverifiable'
      : running.length > 0
        ? 'idle'
        : 'none'
}

// While some run, how often their end is looked for.
export const CONVERSATION_WORKERS_POLL_MS = 10_000
// A worker that never settles cannot keep a conversation working past this after the bot's last turn.
export const CONVERSATION_WORKERS_MAX_RUNNING_MS = 6 * 60 * 60 * 1000
// Lost contact is no exit, but a host that never answers again cannot hold the conversation either.
export const CONVERSATION_WORKERS_MAX_UNVERIFIABLE_MS = 15 * 60 * 1000

type Tracked = {
  pane: ConversationPane
  running: boolean
  // An idle worker is read on: it resumes without a turn of this conversation's.
  open: boolean
  // The bot's last turn end, or the first read when none was seen; bounds a running state.
  since: number
  unverifiableSince: number | null
}

export type ConversationWorkersDeps = Pick<ConversationEventsDeps, 'setTimer' | 'now'> & {
  /** The orchestration workers a chat conversation started; null where none can be read. */
  workerActivity: (link: ExternalConversationLink) => Promise<ConversationWorkerActivity | null>
  linkedFor: (paneKey: string) => LinkedConversation | null
  emit: (event: ConversationEvent) => void
}

/**
 * Why a chat's workers are read: its turn ended (which restarts the running bound), a watch began
 * (whose first read is told even when none runs, since an earlier process may have told otherwise),
 * or a poll while some run.
 */
export type ConversationWorkersRead = 'turn-ended' | 'watch' | 'poll'

/** Tells a `workers` event whenever a chat conversation's running state changes. */
export class ConversationWorkers {
  private readonly tracked = new Map<string, Tracked>()
  // Only a pane's newest read applies.
  private readonly reads = new Map<string, number>()
  private poll: { cancel: () => void } | null = null
  // A clear outdates reads still in flight.
  private generation = 0

  constructor(private readonly deps: ConversationWorkersDeps) {}

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
    return this.reads.has(paneKey)
  }

  async check(paneKey: string, reason: ConversationWorkersRead): Promise<void> {
    const linked = this.deps.linkedFor(paneKey)
    if (!linked) {
      this.forget(paneKey)
      return
    }
    const { generation } = this
    const read = (this.reads.get(paneKey) ?? 0) + 1
    this.reads.set(paneKey, read)
    let activity: ConversationWorkerActivity | null
    try {
      activity = await this.deps.workerActivity(linked.link)
    } catch (error) {
      console.warn('[connector] could not read a conversation’s workers', error)
      // An unread answer is no exit: a running state stays, under the out-of-contact bound.
      const known = this.tracked.get(paneKey)
      activity = known?.running ? 'unverifiable' : known?.open ? 'idle' : 'none'
    }
    if (activity === null || generation !== this.generation || this.reads.get(paneKey) !== read) {
      return
    }
    const now = this.deps.now()
    const prior = this.tracked.get(paneKey)
    const since = reason === 'turn-ended' || !prior ? now : prior.since
    const unverifiableSince = activity === 'unverifiable' ? (prior?.unverifiableSince ?? now) : null
    const open =
      activity !== 'none' &&
      now - since < CONVERSATION_WORKERS_MAX_RUNNING_MS &&
      (unverifiableSince === null ||
        now - unverifiableSince < CONVERSATION_WORKERS_MAX_UNVERIFIABLE_MS)
    const running = open && activity !== 'idle'
    const pane = conversationPane(linked.link, linked.workspace.worktreeId)
    this.tracked.set(paneKey, { pane, running, open, since, unverifiableSince })
    const told = prior ? prior.running : reason === 'watch' ? undefined : false
    if (running !== told) {
      this.deps.emit({ kind: 'workers', ...pane, running })
    }
    this.schedule()
  }

  // An unlinked conversation's workers no longer hold it.
  private forget(paneKey: string): void {
    const tracked = this.tracked.get(paneKey)
    this.tracked.delete(paneKey)
    if (tracked?.running) {
      this.deps.emit({ kind: 'workers', ...tracked.pane, running: false })
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
  }

  clear(): void {
    this.generation++
    this.poll?.cancel()
    this.poll = null
    this.tracked.clear()
    this.reads.clear()
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
