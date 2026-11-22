import { rateLimitSpentUntil } from '../../../../shared/agent-usage/rate-limits/rate-limit-spent-windows'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  isNativeChatUsageLimitCutSchedulable,
  NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS,
  type NativeChatUsageLimitCut
} from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import {
  agentSessionAccountHomePath,
  type AgentSessionAccountHome
} from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  switchFreeIdentity,
  usageLimitContinueIdentity as identity,
  type HostUsageLimitCut,
  type SwitchReset
} from './structured-agent-session-usage-limit-chain'
import {
  sameAccountHome,
  UsageLimitRelaunchedCuts,
  usageLimitCutLaunch,
  type UsageLimitAttributionBinding
} from './structured-agent-session-usage-limit-relaunch'

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
  /** Asks for a first reading while the provider has none, like `refresh`; a due send waits for it
   *  briefly. */
  bootstrap?: (notWithinMs?: number) => boolean
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
  /** What each chat's attribution was computed under. */
  private readonly bindings = new Map<string, UsageLimitAttributionBinding>()
  /** When each chat was first seen continuing on another account than the one its cut hit. */
  private readonly movedSince = new Map<
    string,
    { cut: string; to: AgentSessionAccountHome; at: number }
  >()
  private readonly relaunched = new UsageLimitRelaunchedCuts()
  /** Shared by every chat of a pass and keyed by source witness: work scales with accounts and
   *  their changes, not chats. */
  private launchHomes = new Map<string, Promise<AgentSessionAccountHome | null>>()
  private readings = new Map<string, Promise<UsageLimitAccountScope | undefined>>()

  get size(): number {
    return this.holds.size + this.scopes.size + this.bindings.size
  }

  /** Launch homes and readings resolve again, once each, from here on. */
  beginPass(): void {
    this.launchHomes = new Map()
    this.readings = new Map()
  }

  /** Re-attributed each pass: the account a chat continues on follows the host's selection. The
   *  account the cut hit is the one its turn's runtime launched under, when the record names it. */
  async attribute(
    id: string,
    host: AttributionHost,
    limited: Pick<HostUsageLimitCut, 'turnItemId' | 'resetsAt' | 'fence'> & SwitchReset,
    now = Date.now()
  ): Promise<void> {
    const record = host.store.getRecord(id)
    const cutLaunch = usageLimitCutLaunch(record?.launchedAccount, limited.fence)
    const hit = { cut: switchFreeIdentity(limited), ...cutLaunch }
    const read = host.usageLimitAutoContinue?.accountUsage
    const binding = {
      witness: record ? liveWitness(host, record.provider) : undefined,
      launchFence: record?.launchedAccount?.fence,
      runtimeFence: record?.lease.runtimeFence
    }
    let scope: UsageLimitAccountScope | undefined
    let movedTo: AgentSessionAccountHome | null = null
    let relaunchedOn: AgentSessionAccountHome | null = null
    try {
      // WSL readings never reach this host, so a WSL launch keeps the cut's own reset.
      if (record && record.location.wslDistro === null) {
        // Off WSL a launch home follows only the provider's selection, never the chat.
        const target = JSON.stringify([binding.witness, record.provider])
        let launch = this.launchHomes.get(target)
        if (!launch) {
          launch = (async () => (await host.launchAccountHome?.(record)) ?? null)()
          this.launchHomes.set(target, launch)
        }
        const home = (await launch) ?? record.accountHome
        movedTo = hit.home && !sameAccountHome(home, hit.home) ? home : null
        relaunchedOn = hit?.relaunched ? home : null
        const path = agentSessionAccountHomePath(home)
        if (read && home && path) {
          const key = JSON.stringify([binding.witness, record.provider, path])
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
    // Sources moved or the chat launched again while this resolved: the result mixes them.
    if (record && !this.bindingHolds(id, host, binding)) {
      return
    }
    this.scopes.set(id, scope)
    this.bindings.set(id, binding)
    const since = this.movedSince.get(id)
    if (!movedTo) {
      this.movedSince.delete(id)
    } else if (since?.cut !== hit.cut || !sameAccountHome(since.to, movedTo)) {
      // Each destination counts from when it was chosen, so an older reading of it never releases.
      this.movedSince.set(id, { cut: hit.cut, to: movedTo, at: now })
    }
    this.relaunched.note(id, hit?.cut ?? '', relaunchedOn, cutLaunch?.launchFence, now)
  }

  /** What the chat's attribution was computed under; a send binds to this. */
  attributionBinding(id: string): UsageLimitAttributionBinding | undefined {
    return this.bindings.get(id)
  }

  bindingHolds(
    id: string,
    host: AttributionHost,
    binding: UsageLimitAttributionBinding | undefined
  ): boolean {
    const record = host.store.getRecord(id)
    const holds =
      binding !== undefined &&
      record !== null &&
      liveWitness(host, record.provider) === binding.witness &&
      record.lease.runtimeFence === binding.runtimeFence &&
      record.launchedAccount?.fence === binding.launchFence
    if (!holds) {
      this.scopes.delete(id)
      this.bindings.delete(id)
      this.relaunched.forget(id)
    }
    return holds
  }

  /** Whether the chat has an attribution whose sources and launch still hold. */
  attributionCurrent(id: string, host: AttributionHost): boolean {
    return this.bindingHolds(id, host, this.bindings.get(id))
  }

  retain(shown: ReadonlySet<string>): void {
    for (const cache of [this.holds, this.scopes, this.bindings, this.movedSince]) {
      for (const id of cache.keys()) {
        if (!shown.has(id)) {
          cache.delete(id)
        }
      }
    }
    this.relaunched.retain(shown)
  }

  clear(): void {
    this.holds.clear()
    this.scopes.clear()
    this.bindings.clear()
    this.movedSince.clear()
    this.relaunched.clear()
    this.beginPass()
  }

  /** A cut with no known reset, once the chat continues on an account the cut never hit: the
   *  switch stands in for its reset, so the new account's reading decides as for any other move. */
  withSwitchReset<T extends NativeChatUsageLimitCut>(id: string, cut: T): T & SwitchReset {
    const moved = this.movedSince.get(id)
    return cut.resetsAt === undefined && moved?.cut === switchFreeIdentity(cut)
      ? { ...cut, resetsAt: moved.at, resetFromSwitch: true }
      : cut
  }

  verdict(
    id: string,
    limited: { turnItemId: string; resetsAt: number } & SwitchReset,
    now: number
  ): UsageLimitAccountVerdict {
    // The account the chat moved to never hit this cut: from the move on, only its reading holds.
    const moved = this.movedSince.get(id)
    const movedCut = moved?.cut === switchFreeIdentity(limited)
    const cut = movedCut ? { ...limited, resetsAt: Math.min(limited.resetsAt, moved.at) } : limited
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
    // Spending the new account showed before the move still holds; only a later reading releases it.
    if (
      account &&
      reading &&
      fresh(movedCut ? Number.NEGATIVE_INFINITY : cut.resetsAt) &&
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
      } else if (
        fresh(cut.resetsAt) &&
        reading.updatedAt > (hold.spentSeenAt ?? Number.NEGATIVE_INFINITY)
      ) {
        // Room newer than any spending seen releases the hold at that reading, so it counts from now.
        if (hold.unknownReset || (hold.heldUntil ?? Number.NEGATIVE_INFINITY) > reading.updatedAt) {
          hold.heldUntil = reading.updatedAt
        }
        hold.unknownReset = false
      }
    }
    const heldTo = Math.max(
      cut.resetsAt,
      hold.heldUntil ?? cut.resetsAt,
      (hold.unknownReset && hold.spentSeenAt) || cut.resetsAt
    )
    const room = this.relaunched.roomAt(id, identity(limited), account?.key, reading, now)
    const resetsAt = room !== undefined && room < heldTo && !hold.unknownReset ? room : heldTo
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
    cut: NativeChatUsageLimitCut & SwitchReset,
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
    cut: { turnItemId: string; resetsAt: number } & SwitchReset,
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
      if (this.relaunched.waits(id, identity(cut))) {
        // Only room ends a relaunched cut's wait early, and the poller may be idle: ask for it,
        // a first reading too while the provider has none.
        const ask = scope?.account?.refresh ?? scope?.bootstrap
        ask?.(UNKNOWN_RESET_ASK_MS)
      }
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

/** Changes whenever a source the provider's attribution reads changes. */
function liveWitness(
  host: AttributionHost,
  provider: AgentSessionRecord['provider']
): string | undefined {
  return host.usageLimitAutoContinue?.accountWitness?.(provider)
}
