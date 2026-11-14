import { rateLimitSpentUntil } from '../../../../shared/rate-limit-spent-windows'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { AgentHookEventPayload } from '../../../../shared/agent-hook-listener/listener-event'
import type { RateLimitService } from '../../../rate-limits/service/rate-limit-service'

/** Worker accounts (#9496): what a paused terminal needs from the runtime. */
export type TerminalUsageLimitPauseDeps = {
  /** The Claude account a host worktree is pinned to; only pinned worktrees pause. */
  pinnedAccount: (worktreeId: string) => string | undefined
  /** The latest successful usage reading of that account, or null. */
  reading: (accountId: string) => ProviderRateLimits | null
  /** A non-forced reading of that account; the service keeps its own backoff. */
  requestReading: (accountId: string) => void
  /** Types the continue prompt into the pane's Claude; false when it is not there to take it. */
  send: (paneKey: string) => Promise<boolean>
  now: () => number
}

type PauseEvent = Pick<
  AgentHookEventPayload,
  | 'paneKey'
  | 'worktreeId'
  | 'connectionId'
  | 'hookEventName'
  | 'toolAgentId'
  | 'isReplay'
  | 'claudeStopFailure'
  | 'turnEndedAt'
>

type Pause = {
  accountId: string
  since: number
  /** The limited turn's host end time; a re-published row of the same turn is not a new limit. */
  turnEndedAt?: number
  /** Continues Orca sent since the person last spoke; a chain of limits stops at MAX_SENDS. */
  sends: number
  sentAt?: number
}

const TICK_MS = 10_000
/** Past a known reset, continue even when no newer reading has arrived. */
const RESET_GRACE_MS = 60_000
/** How often a paused account is asked for a reading while its reset is unknown. */
const ASK_MS = 10 * 60_000
const MAX_SENDS = 3

/** A Claude terminal in a pinned worktree that hit its account's usage limit waits for that
 *  account's reset, then continues there; it never moves to another account. */
export class TerminalUsageLimitPauses {
  private readonly pauses = new Map<string, Pause>()
  private readonly askedAt = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(private readonly deps: TerminalUsageLimitPauseDeps) {}

  start(): () => void {
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
    return () => {
      clearInterval(this.timer)
      this.pauses.clear()
    }
  }

  observe(event: PauseEvent): void {
    // Lead turns of local panes only: SSH hosts poll their own accounts, children never stop the lead.
    if (
      event.isReplay ||
      event.connectionId !== null ||
      event.toolAgentId !== undefined ||
      !event.worktreeId
    ) {
      return
    }
    const pause = this.pauses.get(event.paneKey)
    if (event.hookEventName === 'StopFailure' && event.claudeStopFailure === 'rate_limit') {
      const accountId = this.deps.pinnedAccount(event.worktreeId)
      const repeated = pause?.turnEndedAt !== undefined && pause.turnEndedAt === event.turnEndedAt
      if (accountId && !repeated) {
        const sends = pause?.accountId === accountId && pause.sentAt ? pause.sends : 0
        this.pauses.set(event.paneKey, {
          accountId,
          since: this.deps.now(),
          turnEndedAt: event.turnEndedAt,
          sends
        })
      }
      return
    }
    // A finished turn, an exit, or a prompt Orca did not send ends the wait.
    if (
      event.hookEventName === 'Stop' ||
      event.hookEventName === 'SessionEnd' ||
      (event.hookEventName === 'UserPromptSubmit' && !pause?.sentAt)
    ) {
      this.pauses.delete(event.paneKey)
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      const now = this.deps.now()
      for (const [paneKey, pause] of this.pauses) {
        if (pause.sentAt !== undefined || pause.sends >= MAX_SENDS || !this.due(pause, now)) {
          continue
        }
        if (await this.deps.send(paneKey).catch(() => false)) {
          pause.sentAt = this.deps.now()
          pause.sends += 1
        } else {
          // Claude left the pane or a person took it over: nothing is waiting any more.
          this.pauses.delete(paneKey)
        }
      }
    } finally {
      this.running = false
    }
  }

  private due(pause: Pause, now: number): boolean {
    const reading = this.deps.reading(pause.accountId)
    const until = reading ? rateLimitSpentUntil(reading) : null
    if (typeof until === 'number' && now >= until + RESET_GRACE_MS) {
      return true
    }
    // A reading from before the limit says nothing about it.
    if (reading && reading.updatedAt > pause.since && until === undefined) {
      return true
    }
    if (typeof until !== 'number' || (reading && reading.updatedAt < until && now >= until)) {
      this.ask(pause.accountId, now)
    }
    return false
  }

  private ask(accountId: string, now: number): void {
    if (now - (this.askedAt.get(accountId) ?? Number.NEGATIVE_INFINITY) >= ASK_MS) {
      this.askedAt.set(accountId, now)
      this.deps.requestReading(accountId)
    }
  }
}

type PauseRuntime = {
  getTerminalHandleForPaneKey(paneKey: string): string | null | undefined
  sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: { inputKind: 'driving'; onPermission: 'refuse'; acceptQueued: true }
  ): Promise<{ accepted: boolean }>
  readSettings(): { claudeAccountPinsByWorktree?: Record<string, string> }
  usageRateLimits(): Pick<
    RateLimitService,
    | 'usageReadingAccount'
    | 'usageReading'
    | 'requestUsageReading'
    | 'getState'
    | 'fetchInactiveClaudeAccountsOnOpen'
  > | null
}

/** Pauses at a usage limit, fed by every accepted hook event; returns the detach. */
export function attachTerminalUsageLimitPauses(
  store: { subscribeEnrichedStatus?(listener: (row: AgentHookEventPayload) => void): () => void },
  runtime: PauseRuntime
): () => void {
  if (!store.subscribeEnrichedStatus) {
    return () => {}
  }
  const ok = (limits: ProviderRateLimits | null | undefined) =>
    limits?.status === 'ok' ? limits : null
  const isSelected = (accountId: string) =>
    runtime.usageRateLimits()?.usageReadingAccount('claude')?.provenance === `profile:${accountId}`
  const pauses = new TerminalUsageLimitPauses({
    pinnedAccount: (worktreeId) => runtime.readSettings().claudeAccountPinsByWorktree?.[worktreeId],
    reading: (accountId) => {
      const service = runtime.usageRateLimits()
      if (!service) {
        return null
      }
      return isSelected(accountId)
        ? ok(service.usageReading('claude'))
        : ok(
            service
              .getState()
              .inactiveClaudeAccounts.find((account) => account.accountId === accountId)?.rateLimits
          )
    },
    requestReading: (accountId) => {
      const service = runtime.usageRateLimits()
      if (isSelected(accountId)) {
        service?.requestUsageReading('claude')
      } else {
        void service?.fetchInactiveClaudeAccountsOnOpen()
      }
    },
    send: async (paneKey) => {
      const handle = runtime.getTerminalHandleForPaneKey(paneKey)
      if (!handle) {
        return false
      }
      const sent = await runtime.sendTerminalAgentPrompt(handle, CONTINUE_PROMPT, {
        inputKind: 'driving',
        onPermission: 'refuse',
        acceptQueued: true
      })
      return sent.accepted
    },
    now: Date.now
  })
  const stop = pauses.start()
  const unsubscribe = store.subscribeEnrichedStatus((row) => pauses.observe(row))
  return () => {
    unsubscribe()
    stop()
  }
}

/** What the person would type: Claude picks the interrupted task back up in its own conversation. */
const CONTINUE_PROMPT = 'continue'
