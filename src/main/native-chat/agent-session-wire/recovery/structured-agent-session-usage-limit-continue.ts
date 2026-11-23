import type { UsageLimitContinueDeps } from './structured-agent-session-usage-limit-continue-deps'
import { AgentSessionPreDispatchError } from '../operations/structured-agent-session-operation-settlement'
import {
  USAGE_LIMIT_CONTINUE_CHAIN_LIMIT,
  usageLimitContinueIdentity as identity,
  type HostUsageLimitCut
} from './structured-agent-session-usage-limit-chain'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import { RestartContinuationSupersededError } from './structured-agent-session-restart-continuation'
import { UsageLimitAccountHolds } from './structured-agent-session-usage-limit-account-hold'
import { UsageLimitColdCuts } from './structured-agent-session-usage-limit-cold-cuts'
import { usageLimitContinueMutation } from './structured-agent-session-usage-limit-continue-message'
import {
  cancelsCut,
  isUsageLimitChatOpen,
  openUsageLimitChats,
  usageLimitCutDisposition,
  type UsageLimitCutDisposition
} from './structured-agent-session-usage-limit-disposition'

/** Sends per 10 s pass; 64 limited chats freed by one reset start over about 5 minutes. */
export const USAGE_LIMIT_CONTINUE_SENDS_PER_PASS = 2

type Cut = HostUsageLimitCut & { resetsAt: number; turnEndedAt: number }
type Attempt = { identity: string; count: number; at: number; unconfirmed?: boolean }

export { readSavedUsageLimitCut } from './structured-agent-session-usage-limit-chain'

/** Scheduling is derived from the current cut; only a person's cancellation survives restart. */
export class StructuredAgentSessionUsageLimitContinue {
  private timer: ReturnType<typeof setInterval> | undefined
  private stopSettings: (() => void) | undefined
  private running = false
  private disposed = false
  private readonly attempts = new Map<string, Attempt>()
  private readonly holds = new UsageLimitAccountHolds()
  private readonly cold: UsageLimitColdCuts
  private shown = new Set<string>()
  private readonly told = new Set<(sessionId?: string) => void>()

  /** A chat's (or, with none named, every chat's) continue may have ended without a status publish:
   *  the setting turned, or the chat closed. */
  onDispositionChange(listener: (sessionId?: string) => void): () => void {
    this.told.add(listener)
    return () => this.told.delete(listener)
  }

  constructor(private readonly deps: UsageLimitContinueDeps) {
    const switchReset = (id: string, cut: HostUsageLimitCut) =>
      this.holds.withSwitchReset(id, cut, deps.now())
    this.cold = new UsageLimitColdCuts({ ...deps, logger: deps.host.logger, switchReset })
  }

  start(): void {
    // Seeded, so a chat closed before the first sweep is still told closed.
    this.shown = new Set(openUsageLimitChats(this.deps.host.store))
    this.timer = setInterval(() => void this.tick(), 10_000)
    this.timer.unref?.()
    let enabled = this.enabled()
    this.stopSettings = this.deps.host.usageLimitAutoContinue?.subscribe(() => {
      // Other settings writes change nothing published here.
      if (this.enabled() !== enabled) {
        enabled = !enabled
        this.told.forEach((listener) => listener())
        void this.publishScheduled().catch((error: unknown) =>
          this.deps.host.logger.warn('publishing usage-limit schedules failed', {
            scope: 'usage-limit-continue',
            error
          })
        )
      }
    })
  }

  private enabled = (): boolean => this.deps.host.usageLimitAutoContinue?.isEnabled() === true

  /** Only a loaded chat with a cut has a schedule whose state can change; an unknown reset gains
   *  or loses one as the chat's account moves. */
  private async publishScheduled(): Promise<void> {
    for (const id of this.deps.sessions.keys()) {
      const cut = await this.cold.readForSweep(id)
      if (cut !== 'unreadable' && cut !== null) {
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

  /** Drops what the sweep keeps for chats no longer open. */
  private retainShown(visible: readonly string[]): void {
    const shown = new Set(visible)
    // A closed chat has no status publish when it never loaded: say its continue ended here.
    const closed = [...this.shown].filter((id) => !shown.has(id))
    this.shown = shown
    closed.forEach((id) => this.told.forEach((listener) => listener(id)))
    for (const id of this.attempts.keys()) {
      if (!shown.has(id)) {
        this.attempts.delete(id)
      }
    }
    this.cold.retain(shown)
    this.holds.retain(shown)
  }

  readState = (
    id: string,
    read: HostUsageLimitCut | null
  ): AgentSessionStatusSummary['usageLimitContinue'] => {
    const cut = read && this.holds.withSwitchReset(id, read, this.deps.now())
    // A cut Orca can never continue shows only the manual actions, whatever the setting.
    if (!cut || !this.holds.schedulable(id, cut, this.deps.now())) {
      return undefined
    }
    const hold = this.holds.verdict(id, cut, this.deps.now())
    const cancel = this.deps.host.store.getRecord(id)?.usageLimitContinueCancel
    const attempt = this.attempts.get(id)
    const state = cancelsCut(cancel, cut)
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

  /** See usageLimitCutDisposition; the cut read as the journal stands now. */
  disposition = async (id: string, turnItemId: string): Promise<UsageLimitCutDisposition> => {
    const cut = await this.cold.read(id, true)
    const record = this.deps.host.store.getRecord(id)
    const attempt = this.attempts.get(id)
    return usageLimitCutDisposition({
      cut,
      turnItemId,
      continuable:
        cut !== null &&
        this.enabled() &&
        this.holds.schedulable(id, cut, this.deps.now()) &&
        record?.location.executionHostId === this.deps.host.store.hostId &&
        isUsageLimitChatOpen(this.deps.host.store, id),
      cancel: record?.usageLimitContinueCancel,
      attempt: cut && attempt?.identity === identity(cut) ? attempt : undefined
    })
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
      isUsageLimitChatOpen(this.deps.host.store, id) &&
      !cancelsCut(record.usageLimitContinueCancel, cut)
    )
  }

  cancel = (input: { sessionId: string; turnItemId: string; resetsAt: number }): Promise<void> =>
    this.deps.serialize(input.sessionId, async () => {
      const cut = await this.cold.read(input.sessionId, true)
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
      const visible = openUsageLimitChats(this.deps.host.store)
      this.retainShown(visible)
      // Visibility and workspace sleep can change without a journal or settings commit.
      await this.publishScheduled()
      await this.cold.readUnread(visible)
      this.holds.beginPass()
      const due: { id: string; cut: Cut; at: number }[] = []
      for (const id of visible) {
        if (!this.deps.sessions.has(id) && !this.cold.has(id)) {
          continue
        }
        const read = await this.cold.readForSweep(id)
        // Unreadable is not "no cut": its attempt record must survive to guard a repeat send.
        if (read === 'unreadable') {
          continue
        }
        // Before the overdue check: after a restart only the reading still knows a later reset,
        // and a switched account frees the chat before it, even when its reset is unknown.
        if (read) {
          await this.holds.attribute(id, this.deps.host, read, this.deps.now())
        }
        const cut = read && this.holds.withSwitchReset(id, read, this.deps.now())
        const previous = this.attempts.get(id)
        if (!cut || previous?.identity !== identity(cut)) {
          this.attempts.delete(id)
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
      // One at a time, since a cold send can start an agent process; the rest stay due for later
      // passes, so a reset that frees many chats does not start their agents all at once.
      for (const next of due.slice(0, USAGE_LIMIT_CONTINUE_SENDS_PER_PASS)) {
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

  private async deferUnchangedCut(id: string, cut: Cut, at: number): Promise<void> {
    const current = await this.cold.read(id)
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
      await this.holds.attribute(id, this.deps.host, cut, this.deps.now())
    }
    const record = this.deps.host.store.getRecord(id)
    if (!record) {
      return
    }
    // Still moving: yield without spending an attempt; a later pass resolves on settled sources.
    if (!this.holds.attributionCurrent(id, this.deps.host)) {
      await this.deferUnchangedCut(id, cut, this.deps.now())
      return
    }
    // The reading is live: one that arrived during earlier sends holds this one.
    if (!this.holds.ready(id, cut, this.deps.now())) {
      this.deps.publish(id)
      return
    }
    const binding = this.holds.attributionBinding(id)
    const at = this.deps.now()
    const attempt: Attempt = {
      identity: identity(cut),
      count: (this.attempts.get(id)?.count ?? 0) + 1,
      at
    }
    try {
      const result = await this.deps.send({
        ...(await usageLimitContinueMutation({
          sessionId: id,
          cut,
          at,
          expectedRuntimeFence: record.lease.runtimeFence
        })),
        beforeRun: async () => {
          const current = await this.cold.read(id)
          if (
            !current ||
            identity(current) !== identity(cut) ||
            !this.eligible(id, current) ||
            !this.holds.bindingHolds(id, this.deps.host, binding) ||
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
        await this.deferUnchangedCut(id, cut, at)
        return
      }
      this.attempts.set(id, attempt)
    } catch (error) {
      if (error instanceof RestartContinuationSupersededError) {
        await this.deferUnchangedCut(id, cut, at)
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
