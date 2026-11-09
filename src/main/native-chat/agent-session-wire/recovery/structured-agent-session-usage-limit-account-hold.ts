import { rateLimitSpentUntil } from '../../../../shared/rate-limit-spent-windows'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  isNativeChatUsageLimitCutSchedulable,
  type NativeChatUsageLimitCut
} from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import {
  agentSessionAccountHomePath,
  type AgentSessionAccountHome
} from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { usageLimitContinueIdentity as identity } from './structured-agent-session-usage-limit-chain'

/** The polled usage of the account a chat continues on, as the host attributes it. */
export type UsageLimitAccountUsage = {
  /** Attributed home and account identity; state kept for another account never applies. */
  key: string
  /** False when Orca can't tell which login signed into the home (System Default). */
  identityKnown: boolean
  /** The reading now, or null once it no longer describes this account. */
  read: () => ProviderRateLimits | null
  /** A non-forced fetch that keeps the poller's own Retry-After. */
  refresh: () => void
}

/** Where a launch would bill: a hold never outlives the scope it was taken in. */
export type UsageLimitAccountScope = {
  /** Canonical launch home plus billing kind. */
  scope: string
  /** The reading that describes this scope's account; absent when none does. */
  account?: UsageLimitAccountUsage
  /** Asks for a first reading while the provider has none; a due send waits for it briefly. */
  bootstrap?: () => void
}

export type UsageLimitAccountVerdict = {
  /** The latest reset the send waits for: the cut's, or a later one the account still shows spent. */
  resetsAt: number
  /** The account shows a spent window with no known reset; nothing is sent automatically. */
  unknownReset: boolean
  /** Due, but no reading taken since that reset has arrived yet. */
  awaitingReading: boolean
}

type Hold = {
  cut: string
  scope?: string
  account?: string
  heldUntil?: number
  unknownReset?: boolean
  refreshedFor?: number
}

const GRACE_MS = 15_000
/** How long a due send waits for a fresh reading before it goes on the reset it has. */
const READING_WAIT_MS = 120_000

/** Derived each pass from the polled reading; nothing is saved. A hold only grows for its cut and account. */
export class UsageLimitAccountHolds {
  private readonly holds = new Map<string, Hold>()
  private readonly scopes = new Map<string, UsageLimitAccountScope | undefined>()
  /** Shared by every chat of a pass: work scales with accounts, not chats. */
  private launchHomes = new Map<string, Promise<AgentSessionAccountHome | null>>()
  private readings = new Map<string, Promise<UsageLimitAccountScope | undefined>>()

  get size(): number {
    return this.holds.size + this.scopes.size
  }

  /** Launch homes and readings resolve again, once each, from here on. */
  beginPass(): void {
    this.launchHomes = new Map()
    this.readings = new Map()
  }

  /** Re-attributed each pass: the account a chat continues on follows the host's selection. */
  async attribute(
    id: string,
    host: Pick<StructuredAgentSessionHostDeps, 'launchAccountHome' | 'usageLimitAutoContinue'> & {
      store: Pick<AgentSessionRecordStore, 'getRecord'>
    }
  ): Promise<void> {
    const record = host.store.getRecord(id)
    const read = host.usageLimitAutoContinue?.accountUsage
    let scope: UsageLimitAccountScope | undefined
    try {
      // WSL readings never reach this host, so a WSL launch keeps the cut's own reset.
      if (record && read && record.location.wslDistro === null) {
        // Off WSL a launch home follows only the provider's selection, never the chat.
        let launch = this.launchHomes.get(record.provider)
        if (!launch) {
          launch = (async () => (await host.launchAccountHome?.(record)) ?? null)()
          this.launchHomes.set(record.provider, launch)
        }
        const home = (await launch) ?? record.accountHome
        const path = agentSessionAccountHomePath(home)
        if (home && path) {
          const key = JSON.stringify([record.provider, path])
          let reading = this.readings.get(key)
          if (!reading) {
            reading = read(record.provider, home)
            this.readings.set(key, reading)
          }
          scope = await reading
        }
      }
    } catch {
      // No attributable account this pass: the cut's own reset and any hold already seen decide.
    }
    this.scopes.set(id, scope)
  }

  /** Names the scope and account a send was checked against. */
  attributionKey(id: string): string | undefined {
    const scope = this.scopes.get(id)
    return scope && JSON.stringify([scope.scope, scope.account?.key ?? null])
  }

  retain(shown: ReadonlySet<string>): void {
    for (const cache of [this.holds, this.scopes]) {
      for (const id of cache.keys()) {
        if (!shown.has(id)) {
          cache.delete(id)
        }
      }
    }
  }

  forget(id: string): void {
    this.holds.delete(id)
    this.scopes.delete(id)
  }

  clear(): void {
    this.holds.clear()
    this.scopes.clear()
    this.beginPass()
  }

  verdict(
    id: string,
    cut: { turnItemId: string; resetsAt: number },
    now: number
  ): UsageLimitAccountVerdict {
    const scope = this.scopes.get(id)
    let hold = this.holds.get(id)
    // Nothing attributed and nothing held: the cut decides, and nothing is kept for it.
    if (!hold && !scope) {
      return { resetsAt: cut.resetsAt, unknownReset: false, awaitingReading: false }
    }
    const account = scope?.account
    if (
      hold?.cut !== identity(cut) ||
      (scope && hold.scope !== scope.scope) ||
      (account && hold.account !== undefined && hold.account !== account.key)
    ) {
      hold = { cut: identity(cut), ...(scope ? { scope: scope.scope } : {}) }
      this.holds.set(id, hold)
    }
    hold.account = account?.key ?? hold.account
    const reading = account?.read()
    // Only a reading taken since the cut's reset can speak for the account at that reset.
    const fresh = (since: number) =>
      reading?.status === 'ok' &&
      reading.usageMetadata?.source !== 'live-session' &&
      reading.updatedAt >= since
    if (account && reading && fresh(cut.resetsAt)) {
      const spentUntil = rateLimitSpentUntil(reading)
      if (spentUntil === null) {
        hold.unknownReset = true
      } else if (spentUntil !== undefined) {
        hold.heldUntil = Math.max(hold.heldUntil ?? spentUntil, spentUntil)
      } else if (!account.identityKnown) {
        // Room before the held reset means another login now uses this home.
        hold.unknownReset = false
        if (hold.heldUntil !== undefined && reading.updatedAt < hold.heldUntil) {
          hold.heldUntil = undefined
        }
      }
    }
    const resetsAt = Math.max(cut.resetsAt, hold.heldUntil ?? cut.resetsAt)
    return {
      resetsAt,
      unknownReset: hold.unknownReset === true,
      awaitingReading:
        (account ? !fresh(resetsAt) : scope?.bootstrap !== undefined) &&
        now >= resetsAt + GRACE_MS &&
        now < resetsAt + GRACE_MS + READING_WAIT_MS
    }
  }

  /** The day Orca may still continue a cut runs from the reset it actually waits for. */
  schedulable(
    id: string,
    cut: NativeChatUsageLimitCut,
    now: number
  ): cut is NativeChatUsageLimitCut & { resetsAt: number; turnEndedAt: number } {
    // At no time at all, this checks only that the reset is known and later than the turn's end.
    return (
      isNativeChatUsageLimitCutSchedulable(cut, Number.NEGATIVE_INFINITY) &&
      isNativeChatUsageLimitCutSchedulable({ ...cut, ...this.verdict(id, cut, now) }, now)
    )
  }

  /** Whether the send may go now; a due send short of a fresh reading asks once per held reset. */
  ready(
    id: string,
    cut: { turnItemId: string; resetsAt: number },
    now: number,
    notBefore = 0
  ): boolean {
    const hold = this.verdict(id, cut, now)
    if (hold.unknownReset || now < Math.max(hold.resetsAt + GRACE_MS, notBefore)) {
      return false
    }
    const record = this.holds.get(id)
    const scope = this.scopes.get(id)
    const refresh = scope?.account?.refresh ?? scope?.bootstrap
    if (hold.awaitingReading && record && refresh && record.refreshedFor !== hold.resetsAt) {
      record.refreshedFor = hold.resetsAt
      refresh()
    }
    return !hold.awaitingReading
  }
}
