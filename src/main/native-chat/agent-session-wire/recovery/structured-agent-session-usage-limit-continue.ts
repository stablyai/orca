import { AgentSessionPreDispatchError } from '../operations/structured-agent-session-operation-settlement'
import { randomUUID } from 'node:crypto'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE } from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import {
  USAGE_LIMIT_CONTINUE_CHAIN_LIMIT,
  usageLimitContinueIdentity as identity,
  usageLimitContinueMessageId,
  usageLimitContinueTag,
  type HostUsageLimitCut
} from './structured-agent-session-usage-limit-chain'
import { structuredAgentSessionMessageSendMutation } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionHostDeps as HostDeps } from '../host/structured-agent-session-host-types'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { sendStructuredAgentSessionTurn } from '../operations/structured-agent-session-host-mutations'
import { RestartContinuationSupersededError } from './structured-agent-session-restart-continuation'
import { UsageLimitAccountHolds } from './structured-agent-session-usage-limit-account-hold'
import { UsageLimitColdCuts } from './structured-agent-session-usage-limit-cold-cuts'

type Cut = HostUsageLimitCut & { resetsAt: number; turnEndedAt: number }
type Attempt = { identity: string; count: number; at: number; unconfirmed?: boolean }
type Deps = {
  host: Pick<HostDeps, 'usageLimitAutoContinue' | 'logger' | 'launchAccountHome'> & {
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
  readSavedCut: (id: string) => HostUsageLimitCut | null
  serialize: <T>(id: string, run: () => Promise<T>) => Promise<T>
  send: (
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ) => ReturnType<typeof sendStructuredAgentSessionTurn>
  readLoadedCut: (id: string) => HostUsageLimitCut | null
  publish: (id: string) => void
  now: () => number
}

/** Scheduling is derived from the current cut; only a person's cancellation survives restart. */
export class StructuredAgentSessionUsageLimitContinue {
  private timer: ReturnType<typeof setInterval> | undefined
  private stopSettings: (() => void) | undefined
  private running = false
  private disposed = false
  private readonly attempts = new Map<string, Attempt>()
  private readonly holds = new UsageLimitAccountHolds()
  private readonly cold: UsageLimitColdCuts

  constructor(private readonly deps: Deps) {
    this.cold = new UsageLimitColdCuts({ ...deps, logger: deps.host.logger })
  }

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

  dispose(): void {
    this.disposed = true
    clearInterval(this.timer)
    this.stopSettings?.()
    this.cold.clear()
    this.attempts.clear()
    this.holds.clear()
  }

  /** An opened chat reads its cut from the loaded journal; its hold stays until it is hidden. */
  forget = (id: string): void => {
    this.cold.forget(id)
  }

  /** Drops what the sweep keeps for chats no longer shown. */
  private retainShown(visible: readonly string[]): void {
    const shown = new Set(visible)
    for (const id of this.attempts.keys()) {
      if (!shown.has(id)) {
        this.attempts.delete(id)
      }
    }
    this.cold.retain(shown)
    this.holds.retain(shown)
  }

  readState = (id: string): AgentSessionStatusSummary['usageLimitContinue'] => {
    const cut = this.cold.read(id)
    // A cut Orca can never continue shows only the manual actions, whatever the setting.
    if (!cut || !this.holds.schedulable(id, cut, this.deps.now())) {
      return undefined
    }
    const hold = this.holds.verdict(id, cut, this.deps.now())
    const cancel = this.deps.host.store.getRecord(id)?.usageLimitContinueCancel
    const attempt = this.attempts.get(id)
    const state =
      cancel?.turnItemId === cut.turnItemId && cancel.resetsAt === cut.resetsAt
        ? 'cancelled'
        : cut.chain >= USAGE_LIMIT_CONTINUE_CHAIN_LIMIT ||
            (attempt?.identity === identity(cut) && (attempt.count >= 5 || attempt.unconfirmed))
          ? 'failed'
          : this.eligible(id, cut)
            ? 'scheduled'
            : 'off'
    // An unknown reset has no time to promise, yet fresh room still releases it: say nothing.
    if (hold.unknownReset && state === 'scheduled') {
      return undefined
    }
    return {
      turnItemId: cut.turnItemId,
      resetsAt: cut.resetsAt,
      // While the reset is unknown, `hold.resetsAt` is a reading time, not a reset.
      ...(!hold.unknownReset && hold.resetsAt !== cut.resetsAt
        ? { continueAt: hold.resetsAt }
        : {}),
      state
    }
  }

  private eligible(id: string, cut: HostUsageLimitCut): cut is Cut {
    const record = this.deps.host.store.getRecord(id)
    return (
      !this.disposed &&
      cut.chain < USAGE_LIMIT_CONTINUE_CHAIN_LIMIT &&
      this.deps.host.usageLimitAutoContinue?.isEnabled() === true &&
      this.holds.schedulable(id, cut, this.deps.now()) &&
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
      const cut = this.cold.read(input.sessionId, true)
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
    // Off, nothing is sent, but an account switch still moves when Continue applies.
    this.running = true
    try {
      const visible = this.deps.host.store.listVisibleSessionIds()
      this.retainShown(visible)
      // Visibility and workspace sleep can change without a journal or settings commit.
      this.publishScheduled()
      this.cold.readUnread(visible)
      this.holds.beginPass()
      const due: { id: string; cut: Cut; at: number }[] = []
      for (const id of visible) {
        if (!this.deps.sessions.has(id) && !this.cold.has(id)) {
          continue
        }
        const cut = this.cold.read(id)
        const previous = this.attempts.get(id)
        if (!cut || previous?.identity !== identity(cut)) {
          this.attempts.delete(id)
        }
        // Before the overdue check: after a restart only the reading still knows a later reset,
        // and a switched account frees the chat before it.
        if (cut?.resetsAt !== undefined) {
          await this.attribute(id, cut)
        }
        const attempt = this.attempts.get(id)
        if (!cut || !this.eligible(id, cut) || attempt?.unconfirmed || (attempt?.count ?? 0) >= 5) {
          continue
        }
        const retryAt = attempt ? attempt.at + 60_000 * 2 ** Math.max(0, attempt.count - 1) : 0
        if (this.holds.ready(id, cut, this.deps.now(), retryAt)) {
          due.push({ id, cut, at: attempt?.at ?? 0 })
        }
      }
      due.sort((a, b) => a.at - b.at || a.cut.resetsAt - b.cut.resetsAt)
      // Every due chat goes this pass; one at a time, since a cold send can start an agent process.
      for (const next of due) {
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

  /** The account a cut hit is the one its turn's runtime launched under, when the record names it. */
  private attribute(id: string, cut: HostUsageLimitCut): Promise<void> {
    const launched = this.deps.host.store.getRecord(id)?.launchedAccount
    const home = launched && launched.fence === cut.fence ? launched.accountHome : null
    return this.holds.attribute(id, this.deps.host, { cut: identity(cut), home }, this.deps.now())
  }

  private deferUnchangedCut(id: string, cut: Cut, at: number): void {
    const current = this.cold.read(id)
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
    // Earlier sends take time; moved sources resolve again, once per new witness for every chat.
    if (!this.holds.attributionCurrent(id, this.deps.host)) {
      await this.attribute(id, cut)
    }
    const record = this.deps.host.store.getRecord(id)
    if (!record) {
      return
    }
    // Still moving: yield without spending an attempt; a later pass resolves on settled sources.
    if (!this.holds.attributionCurrent(id, this.deps.host)) {
      this.deferUnchangedCut(id, cut, this.deps.now())
      return
    }
    // The reading is live: one that arrived during earlier sends holds this one.
    if (!this.holds.ready(id, cut, this.deps.now())) {
      this.deps.publish(id)
      return
    }
    const witness = this.holds.attributionWitness(id)
    const at = this.deps.now()
    const attempt: Attempt = {
      identity: identity(cut),
      count: (this.attempts.get(id)?.count ?? 0) + 1,
      at
    }
    const tag = usageLimitContinueTag(cut)
    try {
      const result = await this.deps.send({
        ...structuredAgentSessionMessageSendMutation({
          sessionId: id,
          clientOperationId: usageLimitContinueMessageId(
            at,
            tag,
            randomUUID().replaceAll('-', '').slice(0, 16)
          ),
          expectedRuntimeFence: record.lease.runtimeFence,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE }]
          },
          usageLimitContinuationOfTurnItemId: cut.turnItemId
        }),
        beforeRun: () => {
          const current = this.cold.read(id)
          // The reading may have moved since the pass: the account's later reset still holds the send.
          if (
            !current ||
            identity(current) !== identity(cut) ||
            !this.eligible(id, current) ||
            !this.holds.witnessHolds(id, this.deps.host, witness) ||
            !this.holds.ready(id, current, this.deps.now())
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
