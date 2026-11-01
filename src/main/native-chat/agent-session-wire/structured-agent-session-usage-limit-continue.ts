import { AgentSessionPreDispatchError } from './structured-agent-session-operation-settlement'
import { createHash, randomUUID } from 'node:crypto'
import {
  latestNativeChatUsageLimitCut,
  NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE,
  type NativeChatUsageLimitCut
} from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { replayJournal } from '../agent-session-journal/journal-open'
import { renderJournalState } from '../agent-session-journal/journal-reducer'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { sendStructuredAgentSessionTurn } from './structured-agent-session-host-mutations'
import { RestartContinuationSupersededError } from './structured-agent-session-restart-continuation'

type Cut = NativeChatUsageLimitCut & { resetsAt: number; turnEndedAt: number }
type Attempt = { identity: string; count: number; at: number; unconfirmed?: boolean }
type Deps = {
  host: StructuredAgentSessionHostDeps
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  serialize: <T>(id: string, run: () => Promise<T>) => Promise<T>
  send: (
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ) => ReturnType<typeof sendStructuredAgentSessionTurn>
  readLoadedCut: (id: string) => NativeChatUsageLimitCut | null
  publish: (id: string) => void
  now: () => number
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
  private readonly attempts = new Map<string, Attempt>()

  constructor(private readonly deps: Deps) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 10_000)
    this.timer.unref?.()
    this.stopSettings = this.deps.host.usageLimitAutoContinue?.subscribe(() => {
      for (const id of this.deps.sessions.keys()) {
        this.deps.publish(id)
      }
    })
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.stopSettings?.()
    this.coldCuts.clear()
    this.attempts.clear()
  }

  forget = (id: string): void => {
    this.coldCuts.delete(id)
  }

  private readCut(id: string, cold = false): NativeChatUsageLimitCut | null {
    const session = this.deps.sessions.get(id)
    if (session) {
      this.coldCuts.delete(id)
      return this.deps.readLoadedCut(id)
    }
    if (!this.coldCuts.has(id) && cold) {
      const load = replayJournal(this.deps.host.journalDatabase.db, id)
      const snapshot = load && !load.newer && !load.damage ? renderJournalState(load.state) : null
      this.coldCuts.set(
        id,
        snapshot ? latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions) : null
      )
    }
    return this.coldCuts.get(id) ?? null
  }

  readState = (id: string): AgentSessionStatusSummary['usageLimitContinue'] => {
    const cut = this.readCut(id)
    if (
      cut?.resetsAt === undefined ||
      !Number.isFinite(cut.resetsAt) ||
      cut.turnEndedAt === undefined ||
      cut.resetsAt <= cut.turnEndedAt
    ) {
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
      cut.resetsAt !== undefined &&
      Number.isFinite(cut.resetsAt) &&
      cut.turnEndedAt !== undefined &&
      cut.resetsAt > cut.turnEndedAt &&
      record !== null &&
      record.location.executionHostId === this.deps.host.store.hostId &&
      !this.deps.host.usageLimitAutoContinue?.isWorkspaceAsleep(record.location.workspaceId) &&
      this.deps.host.store.getSessionTabId(id) !== null &&
      !(
        record.usageLimitContinueCancel?.turnItemId === cut.turnItemId &&
        record.usageLimitContinueCancel.resetsAt === cut.resetsAt
      )
    )
  }

  cancel = (input: { sessionId: string; turnItemId: string; resetsAt: number }): Promise<void> =>
    this.deps.serialize(input.sessionId, async () => {
      const cut = this.readCut(input.sessionId, true)
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
    if (this.running || this.disposed) {
      return
    }
    this.running = true
    try {
      const visible = new Set(this.deps.host.store.listVisibleSessionIds())
      for (const cache of [this.coldCuts, this.attempts]) {
        for (const id of cache.keys()) {
          if (!visible.has(id)) {
            cache.delete(id)
          }
        }
      }
      // Visibility and workspace sleep can change without a journal or settings commit.
      for (const id of this.deps.sessions.keys()) {
        this.deps.publish(id)
      }
      if (this.deps.host.usageLimitAutoContinue?.isEnabled() !== true) {
        return
      }
      let coldReads = 0
      const due: { id: string; cut: Cut; at: number }[] = []
      for (const id of visible) {
        const cold = !this.deps.sessions.has(id) && !this.coldCuts.has(id)
        if (cold && coldReads++ >= 3) {
          continue
        }
        const cut = this.readCut(id, true)
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
