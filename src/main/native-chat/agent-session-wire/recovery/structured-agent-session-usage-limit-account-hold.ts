import { rateLimitSpentUntil } from '../../../../shared/rate-limit-spent-windows'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  isNativeChatUsageLimitCutSchedulable,
  NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS,
  type NativeChatUsageLimitCut
} from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import {
  agentSessionAccountHomePath,
  agentSessionAccountHomesEqual,
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { usageLimitContinueIdentity as identity } from './structured-agent-session-usage-limit-chain'

/** The polled usage of the account a chat continues on, as the host attributes it. */
export type UsageLimitAccountUsage = {
  /** Attributed home and account identity; state kept for another account never applies. */
  key: string
  /** The reading now, or null once it no longer describes this account. */
  read: () => ProviderRateLimits | null
  /** A non-forced fetch that keeps the poller's Retry-After and failure backoff; with
   *  `notWithinMs`, at most one per account that often, however many chats ask. False when the
   *  service started none. */
  refresh: (notWithinMs?: number) => boolean
}

/** Where a launch would bill: a hold never outlives the scope it was taken in. */
export type UsageLimitAccountScope = {
  /** Canonical launch home plus billing kind. */
  scope: string
  /** The reading that describes this scope's account; absent when none does. */
  account?: UsageLimitAccountUsage
  /** Asks for a first reading while the provider has none; a due send waits for it briefly. */
  bootstrap?: () => boolean
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
  /** When the newest reading that put spending into effect was taken; only later room releases. */
  spentSeenAt?: number
  refreshedFor?: number
  /** When a due send of this held reset first found no reading to wait for. */
  bootstrapSince?: { reset: number; at: number }
}

type AttributionHost = Pick<
  StructuredAgentSessionHostDeps,
  'launchAccountHome' | 'usageLimitAutoContinue'
> & { store: Pick<AgentSessionRecordStore, 'getRecord'> }

const GRACE_MS = 15_000
/** How long a due send waits for a fresh reading before it goes on the reset it has. */
const READING_WAIT_MS = 120_000
/** How often an account with an unknown reset is asked for a reading; only room can end it. */
const UNKNOWN_RESET_ASK_MS = 10 * 60_000

/** Derived each pass from the polled reading; nothing is saved. A hold only grows for its cut and account. */
export class UsageLimitAccountHolds {
  private readonly holds = new Map<string, Hold>()
  private readonly scopes = new Map<string, UsageLimitAccountScope | undefined>()
  /** The source witness each chat's attribution was computed under. */
  private readonly witnesses = new Map<string, string | undefined>()
  /** When each chat was first seen continuing on another account than the one its cut hit. */
  private readonly movedSince = new Map<string, { cut: string; at: number }>()
  /** Shared by every chat of a pass and keyed by source witness: work scales with accounts and
   *  their changes, not chats. */
  private launchHomes = new Map<string, Promise<AgentSessionAccountHome | null>>()
  private readings = new Map<string, Promise<UsageLimitAccountScope | undefined>>()

  get size(): number {
    return this.holds.size + this.scopes.size + this.witnesses.size
  }

  /** Launch homes and readings resolve again, once each, from here on. */
  beginPass(): void {
    this.launchHomes = new Map()
    this.readings = new Map()
  }

  /** Re-attributed each pass: the account a chat continues on follows the host's selection.
   *  `hit` names the cut and the account it hit, when known. */
  async attribute(
    id: string,
    host: AttributionHost,
    hit?: { cut: string; home: AgentSessionAccountHome | null },
    now = Date.now()
  ): Promise<void> {
    const record = host.store.getRecord(id)
    const read = host.usageLimitAutoContinue?.accountUsage
    const witness = record ? liveWitness(host, record.provider) : undefined
    let scope: UsageLimitAccountScope | undefined
    let moved = false
    try {
      // WSL readings never reach this host, so a WSL launch keeps the cut's own reset.
      if (record && record.location.wslDistro === null) {
        // Off WSL a launch home follows only the provider's selection, never the chat.
        const target = JSON.stringify([witness, record.provider])
        let launch = this.launchHomes.get(target)
        if (!launch) {
          launch = (async () => (await host.launchAccountHome?.(record)) ?? null)()
          this.launchHomes.set(target, launch)
        }
        const home = (await launch) ?? record.accountHome
        moved = !!hit?.home && !sameAccountHome(home, hit.home)
        const path = agentSessionAccountHomePath(home)
        if (read && home && path) {
          const key = JSON.stringify([witness, record.provider, path])
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
    if (record && liveWitness(host, record.provider) !== witness) {
      // Sources moved while this resolved: the result mixes them, so nothing stands for the chat.
      this.scopes.delete(id)
      this.witnesses.delete(id)
      return
    }
    this.scopes.set(id, scope)
    this.witnesses.set(id, witness)
    if (!moved || !hit) {
      this.movedSince.delete(id)
    } else if (this.movedSince.get(id)?.cut !== hit.cut) {
      this.movedSince.set(id, { cut: hit.cut, at: now })
    }
  }

  /** The witness the chat's attribution was computed under; a send binds to this one. */
  attributionWitness(id: string): string | undefined {
    return this.witnesses.get(id)
  }

  /** Whether the sources `witness` names still hold for the chat's provider. */
  witnessHolds(id: string, host: AttributionHost, witness: string | undefined): boolean {
    const record = host.store.getRecord(id)
    return record !== null && liveWitness(host, record.provider) === witness
  }

  /** Whether the chat has an attribution whose sources still hold. */
  attributionCurrent(id: string, host: AttributionHost): boolean {
    return this.witnesses.has(id) && this.witnessHolds(id, host, this.witnesses.get(id))
  }

  retain(shown: ReadonlySet<string>): void {
    for (const cache of [this.holds, this.scopes, this.witnesses]) {
      for (const id of cache.keys()) {
        if (!shown.has(id)) {
          cache.delete(id)
        }
      }
    }
    for (const id of this.movedSince.keys()) {
      if (!shown.has(id)) {
        this.movedSince.delete(id)
      }
    }
  }

  clear(): void {
    this.holds.clear()
    this.scopes.clear()
    this.witnesses.clear()
    this.movedSince.clear()
    this.beginPass()
  }

  verdict(
    id: string,
    limited: { turnItemId: string; resetsAt: number },
    now: number
  ): UsageLimitAccountVerdict {
    // The account the chat moved to never hit this cut: from the move on, only its reading holds.
    const moved = this.movedSince.get(id)
    const cut =
      moved?.cut === identity(limited)
        ? { ...limited, resetsAt: Math.min(limited.resetsAt, moved.at) }
        : limited
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
    // Eligibility first: the cut's own reset, this hold (an unknown reset holds from the last reading
    // that showed it), or a spent window that covered that reset. Later spending never revives a cut
    // that is overdue from all of them.
    const covering =
      account && reading && fresh(cut.resetsAt) && rateLimitSpentUntil(reading, cut.resetsAt)
    const anchor = Math.max(
      cut.resetsAt,
      hold.heldUntil ?? cut.resetsAt,
      (hold.unknownReset && hold.spentSeenAt) || cut.resetsAt,
      typeof covering === 'number' ? covering : cut.resetsAt
    )
    if (
      account &&
      reading &&
      fresh(cut.resetsAt) &&
      now - anchor <= NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS
    ) {
      if (typeof covering === 'number') {
        hold.heldUntil = Math.max(hold.heldUntil ?? covering, covering)
      }
      // Eligible: every window spent now holds the send, whenever it began.
      const spentUntil = rateLimitSpentUntil(reading)
      if (spentUntil !== undefined) {
        if (spentUntil === null) {
          hold.unknownReset = true
        } else {
          hold.heldUntil = Math.max(hold.heldUntil ?? spentUntil, spentUntil)
        }
        hold.spentSeenAt = Math.max(hold.spentSeenAt ?? reading.updatedAt, reading.updatedAt)
      } else if (reading.updatedAt > (hold.spentSeenAt ?? Number.NEGATIVE_INFINITY)) {
        // Room newer than any spending seen releases the hold at that reading, so it counts from now.
        if (hold.unknownReset || (hold.heldUntil ?? Number.NEGATIVE_INFINITY) > reading.updatedAt) {
          hold.heldUntil = reading.updatedAt
        }
        hold.unknownReset = false
      }
    }
    const resetsAt = Math.max(
      cut.resetsAt,
      hold.heldUntil ?? cut.resetsAt,
      (hold.unknownReset && hold.spentSeenAt) || cut.resetsAt
    )
    let waitFrom = resetsAt + GRACE_MS
    if (!account && scope?.bootstrap && now >= waitFrom) {
      // A first reading is asked for only once a pass sees the send due, however late that is.
      if (hold.bootstrapSince?.reset !== resetsAt) {
        hold.bootstrapSince = { reset: resetsAt, at: now }
      }
      waitFrom = Math.max(waitFrom, hold.bootstrapSince.at)
    }
    return {
      resetsAt,
      unknownReset: hold.unknownReset === true,
      awaitingReading:
        (account ? !fresh(resetsAt) : scope?.bootstrap !== undefined) &&
        now >= waitFrom &&
        now < waitFrom + READING_WAIT_MS
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

  /** Whether the send may go now; a due send short of a fresh reading asks until the service
   *  starts one read per held reset. */
  ready(
    id: string,
    cut: { turnItemId: string; resetsAt: number },
    now: number,
    notBefore = 0
  ): boolean {
    const hold = this.verdict(id, cut, now)
    const record = this.holds.get(id)
    const scope = this.scopes.get(id)
    if (hold.unknownReset) {
      // The poller may be idle (unfocused, no viewer), and only a reading with room ends this.
      scope?.account?.refresh(UNKNOWN_RESET_ASK_MS)
      return false
    }
    if (now < Math.max(hold.resetsAt + GRACE_MS, notBefore)) {
      return false
    }
    const refresh = scope?.account?.refresh ?? scope?.bootstrap
    if (hold.awaitingReading && record && refresh && record.refreshedFor !== hold.resetsAt) {
      if (refresh()) {
        record.refreshedFor = hold.resetsAt
      }
    }
    return !hold.awaitingReading
  }
}

function sameAccountHome(left: AgentSessionAccountHome, right: AgentSessionAccountHome): boolean {
  return isLegacyAgentSessionAccountHome(left) && isLegacyAgentSessionAccountHome(right)
    ? left.variable === right.variable &&
        normalizeRuntimePathForComparison(left.path) ===
          normalizeRuntimePathForComparison(right.path)
    : agentSessionAccountHomesEqual(left, right)
}

/** Changes whenever a source the provider's attribution reads changes. */
function liveWitness(
  host: AttributionHost,
  provider: AgentSessionRecord['provider']
): string | undefined {
  return host.usageLimitAutoContinue?.accountWitness?.(provider)
}
