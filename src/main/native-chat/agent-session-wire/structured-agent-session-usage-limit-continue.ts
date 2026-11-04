import { AgentSessionPreDispatchError } from './structured-agent-session-operation-settlement'
import { createHash, randomUUID } from 'node:crypto'
import {
  isNativeChatUsageLimitCutSchedulable,
  latestNativeChatUsageLimitCut,
  NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE,
  type NativeChatUsageLimitCut
} from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session/agent-session-wire'
import { restoreJournalAsync } from '../agent-session-journal/journal-async-open'
import { renderJournalState } from '../agent-session-journal/journal-reducer'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { sendStructuredAgentSessionTurn } from './structured-agent-session-host-mutations'
import { RestartContinuationSupersededError } from './structured-agent-session-restart-continuation'

type Cut = NativeChatUsageLimitCut & { resetsAt: number; turnEndedAt: number }
type Attempt = { identity: string; count: number; at: number; unconfirmed?: boolean }
type Deps = {
  host: Pick<StructuredAgentSessionHostDeps, 'usageLimitAutoContinue' | 'logger'> & {
    store: Pick<
      AgentSessionRecordStore,
      | 'listVisibleSessionIds'
      | 'getRecord'
      | 'hostId'
      | 'isSessionTabVisible'
      | 'cancelUsageLimitContinue'
    >
  }
  sessions: ReadonlyMap<string, unknown>
  /** Reads an unopened chat's saved cut; history-sized, so the sweep budgets it. */
  readSavedCut: (
    id: string
  ) => NativeChatUsageLimitCut | null | Promise<NativeChatUsageLimitCut | null>
  serialize: <T>(id: string, run: () => Promise<T>) => Promise<T>
  send: (
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ) => ReturnType<typeof sendStructuredAgentSessionTurn>
  readLoadedCut: (id: string) => NativeChatUsageLimitCut | null
  publish: (id: string) => void
  now: () => number
}

/** Reads a chat's saved conversation without opening it, as main does for unopened chats. */
export async function readSavedUsageLimitCut(
  database: JournalHostDatabase,
  id: string
): Promise<NativeChatUsageLimitCut | null> {
  const load = await database.read((read) => restoreJournalAsync(read, id))
  const snapshot = load && !load.newer && !load.damage ? renderJournalState(load.state) : null
  return snapshot ? latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions) : null
}

const identity = (cut: NativeChatUsageLimitCut): string =>
  JSON.stringify([cut.turnItemId, cut.resetsAt])

/** Scheduling is derived from the current cut; only a person's cancellation survives restart. */
export class StructuredAgentSessionUsageLimitContinue {
  private timer: ReturnType<typeof setInterval> | undefined
  private stopSettings: (() => void) | undefined
  private running = false
  private disposed = false
  private readonly coldCuts = new Map<string, NativeChatUsageLimitCut | null>()
  /** Pass of each chat's last failed history read; failed reads wait behind unread chats. */
  private readonly coldFailures = new Map<string, number>()
  private readonly attempts = new Map<string, Attempt>()
  private passes = 0

  constructor(private readonly deps: Deps) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 10_000)
    this.timer.unref?.()
    let enabled = this.enabled()
    this.stopSettings = this.deps.host.usageLimitAutoContinue?.subscribe(() => {
      // Other settings writes change nothing published here.
      if (this.enabled() !== enabled) {
        enabled = !enabled
        this.publishScheduled()
      }
    })
  }

  private enabled = (): boolean => this.deps.host.usageLimitAutoContinue?.isEnabled() === true

  /** Only a loaded chat with a known reset has a schedule whose state can change. */
  private publishScheduled(): void {
    for (const id of this.deps.sessions.keys()) {
      if (this.deps.readLoadedCut(id)?.resetsAt !== undefined) {
        this.deps.publish(id)
      }
    }
  }

  /** At most three history reads per pass; a read that throws stays retryable without starving others. */
  private async readColdCuts(visible: readonly string[]): Promise<void> {
    const pass = ++this.passes
    const unread = visible.filter((id) => !this.deps.sessions.has(id) && !this.coldCuts.has(id))
    unread.sort((a, b) => (this.coldFailures.get(a) ?? 0) - (this.coldFailures.get(b) ?? 0))
    for (const id of unread.slice(0, 3)) {
      try {
        await this.loadColdCut(id)
        this.coldFailures.delete(id)
      } catch (error) {
        if (!this.coldFailures.has(id)) {
          this.deps.host.logger.warn('usage-limit continue could not read a chat', {
            scope: 'usage-limit-continue',
            sessionId: id,
            error
          })
        }
        this.coldFailures.set(id, pass)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.stopSettings?.()
    this.coldCuts.clear()
    this.coldFailures.clear()
    this.attempts.clear()
  }

  forget = (id: string): void => {
    this.coldCuts.delete(id)
    this.coldFailures.delete(id)
  }

  private readCut(id: string): NativeChatUsageLimitCut | null {
    if (this.deps.sessions.has(id)) {
      this.coldCuts.delete(id)
      return this.deps.readLoadedCut(id)
    }

    return this.coldCuts.get(id) ?? null
  }

  private async loadColdCut(id: string): Promise<NativeChatUsageLimitCut | null> {
    if (!this.deps.sessions.has(id) && !this.coldCuts.has(id)) {
      const cut = await this.deps.readSavedCut(id)
      if (!this.disposed && !this.deps.sessions.has(id)) {
        this.coldCuts.set(id, cut)
      }
    }
    return this.readCut(id)
  }

  readState = (id: string): AgentSessionStatusSummary['usageLimitContinue'] => {
    const cut = this.readCut(id)
    // A cut Orca can never continue shows only the manual actions, whatever the setting.
    if (!cut || !isNativeChatUsageLimitCutSchedulable(cut, this.deps.now())) {
      return undefined
    }
    const cancel = this.deps.host.store.getRecord(id)?.usageLimitContinueCancel
    const attempt = this.attempts.get(id)
    const state =
      cancel?.turnItemId === cut.turnItemId && cancel.resetsAt === cut.resetsAt
        ? 'cancelled'
        : attempt?.identity === identity(cut) && (attempt.count >= 5 || attempt.unconfirmed)
          ? 'failed'
          : this.eligible(id, cut)
            ? 'scheduled'
            : 'off'
    return { turnItemId: cut.turnItemId, resetsAt: cut.resetsAt, state }
  }

  private eligible(id: string, cut: NativeChatUsageLimitCut): cut is Cut {
    const record = this.deps.host.store.getRecord(id)
    return (
      !this.disposed &&
      this.deps.host.usageLimitAutoContinue?.isEnabled() === true &&
      isNativeChatUsageLimitCutSchedulable(cut, this.deps.now()) &&
      record !== null &&
      record.location.executionHostId === this.deps.host.store.hostId &&
      !this.deps.host.usageLimitAutoContinue?.isWorkspaceAsleep(record.location.workspaceId) &&
      this.deps.host.store.isSessionTabVisible(id) &&
      !(
        record.usageLimitContinueCancel?.turnItemId === cut.turnItemId &&
        record.usageLimitContinueCancel.resetsAt === cut.resetsAt
      )
    )
  }

  cancel = (input: { sessionId: string; turnItemId: string; resetsAt: number }): Promise<void> =>
    this.deps.serialize(input.sessionId, async () => {
      const cut = await this.loadColdCut(input.sessionId)
      if (!cut || identity(cut) !== identity(input)) {
        return
      }
      await this.deps.host.store.cancelUsageLimitContinue(input.sessionId, {
        turnItemId: input.turnItemId,
        resetsAt: input.resetsAt
      })
      this.deps.publish(input.sessionId)
    })

  async tick(): Promise<void> {
    // Off, nothing can be scheduled; the settings listener publishes the switch itself.
    if (this.running || this.disposed || !this.enabled()) {
      return
    }
    this.running = true
    try {
      const visible = this.deps.host.store.listVisibleSessionIds()
      const shown = new Set(visible)
      for (const cache of [this.coldCuts, this.coldFailures, this.attempts]) {
        for (const id of cache.keys()) {
          if (!shown.has(id)) {
            cache.delete(id)
          }
        }
      }
      // Visibility and workspace sleep can change without a journal or settings commit.
      this.publishScheduled()
      await this.readColdCuts(visible)
      const due: { id: string; cut: Cut; at: number }[] = []
      for (const id of visible) {
        if (!this.deps.sessions.has(id) && !this.coldCuts.has(id)) {
          continue
        }
        const cut = this.readCut(id)
        const previous = this.attempts.get(id)
        if (!cut || previous?.identity !== identity(cut)) {
          this.attempts.delete(id)
        }
        const attempt = this.attempts.get(id)
        if (!cut || !this.eligible(id, cut) || attempt?.unconfirmed || (attempt?.count ?? 0) >= 5) {
          continue
        }
        const retryAt = attempt ? attempt.at + 60_000 * 2 ** Math.max(0, attempt.count - 1) : 0
        if (this.deps.now() >= Math.max(cut.resetsAt + 15_000, retryAt)) {
          due.push({ id, cut, at: attempt?.at ?? 0 })
        }
      }
      due.sort((a, b) => a.at - b.at || a.cut.resetsAt - b.cut.resetsAt)
      const next = due[0]
      if (next) {
        await this.send(next.id, next.cut)
      }
    } catch (error) {
      this.deps.host.logger.warn('usage-limit continue sweep failed', {
        scope: 'usage-limit-continue',
        error
      })
    } finally {
      this.running = false
    }
  }

  private deferUnchangedCut(id: string, cut: Cut, at: number): void {
    const current = this.readCut(id)
    // Admission also refuses temporary backlog; yield the next passes without spending a failure.
    if (current && identity(current) === identity(cut)) {
      this.attempts.set(id, {
        identity: identity(cut),
        count: this.attempts.get(id)?.count ?? 0,
        at
      })
    } else {
      this.attempts.delete(id)
    }
  }

  private async send(id: string, cut: Cut): Promise<void> {
    const record = this.deps.host.store.getRecord(id)
    if (!record) {
      return
    }
    const at = this.deps.now()
    const attempt: Attempt = {
      identity: identity(cut),
      count: (this.attempts.get(id)?.count ?? 0) + 1,
      at
    }
    const tag = createHash('sha256').update(identity(cut)).digest('hex').slice(0, 16)
    try {
      const result = await this.deps.send({
        ...structuredAgentSessionMessageSendMutation({
          sessionId: id,
          clientOperationId: `${Math.trunc(at).toString().padStart(13, '0')}-${tag}${randomUUID().replaceAll('-', '').slice(0, 16)}`,
          expectedRuntimeFence: record.lease.runtimeFence,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE }]
          },
          usageLimitContinuationOfTurnItemId: cut.turnItemId
        }),
        beforeRun: () => {
          const current = this.readCut(id)
          if (
            !current ||
            identity(current) !== identity(cut) ||
            !this.eligible(id, current) ||
            this.deps.now() < cut.resetsAt + 15_000
          ) {
            throw new RestartContinuationSupersededError()
          }
        }
      })
      if (result.ok) {
        return
      }
      if (result.refusal.details?.reason === 'continuationSuperseded') {
        this.deferUnchangedCut(id, cut, at)
        return
      }
      this.attempts.set(id, attempt)
    } catch (error) {
      if (error instanceof RestartContinuationSupersededError) {
        this.deferUnchangedCut(id, cut, at)
        return
      }
      // An exception cannot prove the message was refused before acceptance; never send it twice.
      this.attempts.set(
        id,
        error instanceof AgentSessionPreDispatchError ? attempt : { ...attempt, unconfirmed: true }
      )
      this.deps.host.logger.warn('automatic continue could not be confirmed', {
        scope: 'usage-limit-continue',
        sessionId: id,
        error
      })
    }
    this.deps.publish(id)
  }
}
