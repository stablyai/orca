import { AgentSessionPreDispatchError } from '../operations/structured-agent-session-operation-settlement'
import { randomUUID } from 'node:crypto'
import {
  isNativeChatUsageLimitCutSchedulable,
  NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE
} from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import {
  USAGE_LIMIT_CONTINUE_CHAIN_LIMIT,
  usageLimitContinueIdentity as identity,
  usageLimitContinueMessageId,
  usageLimitContinueTag,
  type HostUsageLimitCut
} from './structured-agent-session-usage-limit-chain'
import { structuredAgentSessionMessageSendMutation } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { sendStructuredAgentSessionTurn } from '../operations/structured-agent-session-host-mutations'
import { RestartContinuationSupersededError } from './structured-agent-session-restart-continuation'

type Cut = HostUsageLimitCut & { resetsAt: number; turnEndedAt: number }
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
  private readonly coldCuts = new Map<string, HostUsageLimitCut | null>()
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
  private readColdCuts(visible: readonly string[]): void {
    const pass = ++this.passes
    const unread = visible.filter((id) => !this.deps.sessions.has(id) && !this.coldCuts.has(id))
    unread.sort((a, b) => (this.coldFailures.get(a) ?? 0) - (this.coldFailures.get(b) ?? 0))
    for (const id of unread.slice(0, 3)) {
      try {
        this.readCut(id, true)
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

  private readCut(id: string, cold = false): HostUsageLimitCut | null {
    if (this.deps.sessions.has(id)) {
      this.coldCuts.delete(id)
      return this.deps.readLoadedCut(id)
    }
    if (!this.coldCuts.has(id) && cold) {
      this.coldCuts.set(id, this.deps.readSavedCut(id))
    }
    return this.coldCuts.get(id) ?? null
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
        : cut.chain >= USAGE_LIMIT_CONTINUE_CHAIN_LIMIT ||
            (attempt?.identity === identity(cut) && (attempt.count >= 5 || attempt.unconfirmed))
          ? 'failed'
          : this.eligible(id, cut)
            ? 'scheduled'
            : 'off'
    return { turnItemId: cut.turnItemId, resetsAt: cut.resetsAt, state }
  }

  private eligible(id: string, cut: HostUsageLimitCut): cut is Cut {
    const record = this.deps.host.store.getRecord(id)
    return (
      !this.disposed &&
      cut.chain < USAGE_LIMIT_CONTINUE_CHAIN_LIMIT &&
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
      this.readColdCuts(visible)
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
