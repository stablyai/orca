/** Chat workers whose turn is open but whose model is not answering. Each working chat worker has one
 *  journal subscription and one timer. Every journal change restarts the stopwatch except a retry row,
 *  so a retry still going is waiting too; a running root tool call, or a prompt waiting on a person,
 *  pauses it. Nothing is read when the timer fires: the changes already said what is open. */
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-producer'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import {
  reportWorkerModelWait,
  WORKER_MODEL_WAIT_MS,
  type WorkerModelWaitNotice
} from './worker-model-wait-report'
import type { WorkerTurnStopReportDeps } from './worker-turn-stop-report'

export type ChatModelWaitJournal = {
  /** Calls `onItems` with the ids each commit changed; returns the unsubscribe. */
  observe: (sessionId: string, onItems: (itemIds: readonly string[]) => void) => () => void
  item: (sessionId: string, itemId: string) => Promise<AgentJournalRenderItem | null>
}

const hostJournal: ChatModelWaitJournal = {
  observe: (sessionId, onItems) => {
    const host = getStructuredAgentSessionHost()
    if (!host) {
      return () => {}
    }
    return host.observeConversationPublications(sessionId, {
      next: (publication) => {
        const ids = publication.commit?.items.flatMap((item) => (item.deleted ? [] : [item.itemId]))
        if (ids?.length) {
          onItems(ids)
        }
      },
      error: (error) =>
        console.warn('[orchestration] chat model-wait watch failed', sessionId, error)
    })
  },
  // The host's item read serves any item, not only approvals.
  item: async (sessionId, itemId) =>
    (await getStructuredAgentSessionHost()?.approvalPrompt(sessionId, itemId)) ?? null
}

type Watch = {
  turnKey: string
  /** Host clock at the last journal change that was not a retry row. */
  activityAt: number
  /** Root tool calls running and prompts waiting on a person: the model is not what is awaited. */
  paused: Set<string>
  /** Items whose revisions never matter here (messages, reasoning, the turn row): no read needed. */
  plain: Set<string>
  lastRetry?: string
  retried: boolean
  cancelTimer: () => void
  unsubscribe: () => void
}

type Timer = (run: () => void, delayMs: number) => () => void

const unrefTimer: Timer = (run, delayMs) => {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export class ChatWorkerModelWait {
  private readonly watches = new Map<string, Watch>()

  constructor(
    private readonly deps: WorkerTurnStopReportDeps,
    private readonly journal: ChatModelWaitJournal = hostJournal,
    private readonly setTimer: Timer = unrefTimer,
    private readonly now: () => number = Date.now
  ) {}

  /** A chat's working edge starts its watch, if a worker Dispatch is open on it; any other edge ends it. */
  observe(sessionId: string, working: boolean): void {
    if (!working) {
      this.end(sessionId)
      return
    }
    const db = this.deps.getDb()
    if (this.watches.has(sessionId) || !db || chatWorkerDispatches(sessionId, db).length === 0) {
      return
    }
    const startedAt = this.now()
    const watch: Watch = {
      turnKey: `${sessionId}:${startedAt}`,
      activityAt: startedAt,
      paused: new Set(),
      plain: new Set(),
      retried: false,
      cancelTimer: () => {},
      unsubscribe: () => {}
    }
    this.watches.set(sessionId, watch)
    watch.unsubscribe = this.journal.observe(sessionId, (ids) =>
      this.changed(sessionId, watch, ids)
    )
    this.arm(sessionId, watch, WORKER_MODEL_WAIT_MS)
  }

  dispose(): void {
    for (const sessionId of this.watches.keys()) {
      this.end(sessionId)
    }
  }

  private end(sessionId: string): void {
    const watch = this.watches.get(sessionId)
    if (watch) {
      this.watches.delete(sessionId)
      watch.cancelTimer()
      watch.unsubscribe()
    }
  }

  private changed(sessionId: string, watch: Watch, itemIds: readonly string[]): void {
    for (const itemId of itemIds) {
      if (watch.plain.has(itemId)) {
        watch.activityAt = this.now()
        continue
      }
      void this.journal
        .item(sessionId, itemId)
        .then((item) => {
          if (item && this.watches.get(sessionId) === watch) {
            this.classify(sessionId, watch, item)
          }
        })
        .catch((error: unknown) => {
          console.warn('[orchestration] reading a chat model-wait item failed', sessionId, error)
        })
    }
  }

  private classify(sessionId: string, watch: Watch, item: AgentJournalRenderItem): void {
    const { body, itemId } = item
    if (body.kind === 'status' && body.failure?.kind === 'providerRetrying') {
      watch.lastRetry = body.text
      if (!watch.retried) {
        watch.retried = true
        this.report(sessionId, {
          kind: 'retrying',
          stretchKey: watch.turnKey,
          lastSeen: body.text
        })
      }
      return
    }
    watch.activityAt = this.now()
    const pauses =
      (body.kind === 'tool-call' && isRootAgentJournalItem(item) && body.state === 'running') ||
      ((body.kind === 'approval' || body.kind === 'question') &&
        body.resolution.state === 'pending')
    if (pauses) {
      watch.paused.add(itemId)
    } else {
      watch.paused.delete(itemId)
      if (body.kind !== 'tool-call' && body.kind !== 'approval' && body.kind !== 'question') {
        watch.plain.add(itemId)
      }
    }
  }

  private arm(sessionId: string, watch: Watch, delayMs: number): void {
    watch.cancelTimer = this.setTimer(() => this.elapsed(sessionId, watch), delayMs)
  }

  private elapsed(sessionId: string, watch: Watch): void {
    if (this.watches.get(sessionId) !== watch) {
      return
    }
    // A tool or person ending is itself a change, which restarts the stopwatch from there.
    if (watch.paused.size > 0) {
      this.arm(sessionId, watch, WORKER_MODEL_WAIT_MS)
      return
    }
    const waited = this.now() - watch.activityAt
    if (waited < WORKER_MODEL_WAIT_MS) {
      this.arm(sessionId, watch, WORKER_MODEL_WAIT_MS - waited)
      return
    }
    this.report(sessionId, {
      kind: 'waiting',
      stretchKey: `${watch.turnKey}:${watch.activityAt}`,
      waitedMs: waited,
      ...(watch.lastRetry ? { lastSeen: watch.lastRetry } : {})
    })
    this.arm(sessionId, watch, WORKER_MODEL_WAIT_MS)
  }

  private report(sessionId: string, notice: Omit<WorkerModelWaitNotice, 'from'>): void {
    try {
      const db = this.deps.getDb()
      if (!db) {
        return
      }
      for (const { dispatch, from } of chatWorkerDispatches(sessionId, db)) {
        reportWorkerModelWait(db, { kind: 'local', dispatch }, { ...notice, from }, this.deps)
      }
    } catch (error) {
      console.warn('[orchestration] chat model-wait report failed', sessionId, error)
    }
  }
}
