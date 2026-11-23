import { rateLimitSpentUntil } from '../../../../shared/agent-usage/rate-limits/rate-limit-spent-windows'
import {
  NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS,
  type NativeChatUsageLimitCut
} from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
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
  usageLimitAttributionBindingHolds,
  type UsageLimitAttributionBinding
} from './structured-agent-session-usage-limit-relaunch'
import {
  isAccountHoldSchedulable,
  withMovedCutReset
} from './structured-agent-session-usage-limit-account-schedule'
import type {
  UsageLimitAccountScope,
  UsageLimitAccountVerdict
} from './structured-agent-session-usage-limit-account-types'
export type {
  UsageLimitAccountScope,
  UsageLimitAccountUsage,
  UsageLimitAccountVerdict
} from './structured-agent-session-usage-limit-account-types'
type Hold = {
  cut: string
  scope?: string
  account?: string
  heldUntil?: number
  unknownReset?: boolean
  /** When the newest reading that put spending into effect was taken; only later room releases. */
  spentSeenAt?: number
  refreshedFor?: number
  bootstrapSince?: { reset: number; at: number }
}

type AttributionHost = Pick<
  StructuredAgentSessionHostDeps,
  'launchAccountHome' | 'usageLimitAutoContinue'
> & { store: Pick<AgentSessionRecordStore, 'getRecord'> }

const GRACE_MS = 15_000
const READING_WAIT_MS = 120_000
const UNKNOWN_RESET_ASK_MS = 10 * 60_000

export class UsageLimitAccountHolds {
  private readonly holds = new Map<string, Hold>()
  private readonly scopes = new Map<string, UsageLimitAccountScope | undefined>()
  private readonly bindings = new Map<string, UsageLimitAttributionBinding>()
  private readonly providers = new Map<string, string>()
  private readonly movedSince = new Map<
    string,
    { cut: string; to: AgentSessionAccountHome; at: number }
  >()
  private readonly relaunched = new UsageLimitRelaunchedCuts()
  private launchHomes = new Map<string, Promise<AgentSessionAccountHome | null>>()
  private readings = new Map<string, Promise<UsageLimitAccountScope | undefined>>()

  beginPass(): void {
    this.launchHomes = new Map()
    this.readings = new Map()
  }

  /** Re-attributed each pass: the account a chat continues on follows the host's selection. The
   *  account the cut hit is the one its turn's runtime launched under, when the record still names
   *  that launch. */
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
      witness: record ? host.usageLimitAutoContinue?.accountWitness?.(record.provider) : undefined,
      launchFence: record?.launchedAccount?.fence,
      runtimeFence: record?.lease?.runtimeFence
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
            const pending = read(record.provider, home)
            this.readings.set(key, pending)
            reading = pending
          }
          scope = await reading
        }
      }
    } catch {
      // No attributable account this pass: the cut's own reset and any hold already seen decide.
    }
    if (record && !this.bindingHolds(id, host, binding)) {
      return
    }
    this.scopes.set(id, scope)
    this.bindings.set(id, binding)
    if (record) {
      this.providers.set(id, record.provider)
    }
    const since = this.movedSince.get(id)
    if (!movedTo) {
      this.movedSince.delete(id)
    } else if (since?.cut !== hit.cut || !sameAccountHome(since.to, movedTo)) {
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
    const holds = usageLimitAttributionBindingHolds(id, host, binding)
    if (!holds) {
      this.scopes.delete(id)
      this.bindings.delete(id)
      this.relaunched.forget(id)
    }
    return holds
  }

  retain(shown: ReadonlySet<string>): void {
    for (const cache of [this.holds, this.scopes, this.bindings, this.providers, this.movedSince]) {
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
    this.providers.clear()
    this.movedSince.clear()
    this.relaunched.clear()
    this.beginPass()
  }

  withSwitchReset<T extends NativeChatUsageLimitCut>(id: string, cut: T): T & SwitchReset {
    const moved = this.movedSince.get(id)
    const relaunchedAt = this.relaunched.at(id, switchFreeIdentity(cut))
    return withMovedCutReset(
      moved ?? (relaunchedAt ? { cut: switchFreeIdentity(cut), at: relaunchedAt } : undefined),
      cut
    )
  }

  askForRelaunchRoom = (id: string, cut: NativeChatUsageLimitCut & SwitchReset): void =>
    this.relaunched.askForRoom(
      id,
      cut,
      this.providers.get(id),
      this.bindings.get(id)?.witness,
      this.scopes.get(id)
    )
  verdict(
    id: string,
    limited: { turnItemId: string; resetsAt: number } & SwitchReset,
    now: number
  ): UsageLimitAccountVerdict {
    const moved = this.movedSince.get(id),
      movedCut = moved?.cut === switchFreeIdentity(limited)
    const cut = movedCut ? { ...limited, resetsAt: Math.min(limited.resetsAt, moved.at) } : limited
    let [scope, hold] = [this.scopes.get(id), this.holds.get(id)]
    const awaitingRoom =
      limited.resetFromSwitch === true &&
      this.relaunched.at(id, switchFreeIdentity(limited)) !== undefined
    if (!hold && !scope) {
      return { resetsAt: cut.resetsAt, unknownReset: false, awaitingReading: false, awaitingRoom }
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
      fresh(movedCut ? Number.NEGATIVE_INFINITY : cut.resetsAt) &&
      now - anchor <= NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS
    ) {
      if (typeof covering === 'number') {
        hold.heldUntil = Math.max(hold.heldUntil ?? covering, covering)
      }
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
    const room = this.relaunched.roomAt(id, switchFreeIdentity(limited), account?.key, reading, now)
    if (awaitingRoom && room !== undefined) {
      hold.unknownReset = false
    }
    const heldTo = Math.max(
      cut.resetsAt,
      hold.heldUntil ?? cut.resetsAt,
      (hold.unknownReset && hold.spentSeenAt) || cut.resetsAt
    )
    const resetsAt =
      room !== undefined && !hold.unknownReset && (awaitingRoom || room < heldTo) ? room : heldTo
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
        now < waitFrom + READING_WAIT_MS,
      awaitingRoom: awaitingRoom && room === undefined
    }
  }

  schedulable(
    id: string,
    cut: NativeChatUsageLimitCut & SwitchReset,
    now: number
  ): cut is NativeChatUsageLimitCut & { resetsAt: number; turnEndedAt: number } {
    return isAccountHoldSchedulable(cut, now, (limited) => this.verdict(id, limited, now))
  }

  ready(
    id: string,
    cut: { turnItemId: string; resetsAt: number } & SwitchReset,
    now: number,
    notBefore = 0
  ): boolean {
    const hold = this.verdict(id, cut, now)
    const [record, scope] = [this.holds.get(id), this.scopes.get(id)]
    if (hold.awaitingRoom) {
      return false
    }
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
