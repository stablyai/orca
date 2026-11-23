import { rateLimitShowsRoom } from '../../../../shared/agent-usage/rate-limits/rate-limit-spent-windows'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS } from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import {
  agentSessionAccountHomesEqual,
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome,
  type AgentSessionLaunchedAccount
} from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { UsageLimitAccountScope } from './structured-agent-session-usage-limit-account-types'
import { switchFreeIdentity, type SwitchReset } from './structured-agent-session-usage-limit-chain'
import type { NativeChatUsageLimitCut } from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'

export function sameAccountHome(
  left: AgentSessionAccountHome,
  right: AgentSessionAccountHome
): boolean {
  return isLegacyAgentSessionAccountHome(left) && isLegacyAgentSessionAccountHome(right)
    ? left.variable === right.variable &&
        normalizeRuntimePathForComparison(left.path) ===
          normalizeRuntimePathForComparison(right.path)
    : agentSessionAccountHomesEqual(left, right)
}

/** The account a cut hit, as the record names it: the record keeps only the latest launch, so a
 *  launch at a later fence than the cut's leaves that account unknown (`relaunched`, at
 *  `launchFence`). */
export function usageLimitCutLaunch(
  launched: AgentSessionLaunchedAccount | undefined,
  fence: number | undefined
): { home: AgentSessionAccountHome | null; relaunched: boolean; launchFence?: number } {
  const relaunched = launched !== undefined && fence !== undefined && launched.fence > fence
  return {
    home: launched && launched.fence === fence ? launched.accountHome : null,
    relaunched,
    ...(relaunched ? { launchFence: launched.fence } : {})
  }
}

/** What a chat's attribution was computed under: the sources' witness and the launch the record
 *  named. A send binds to both. */
export type UsageLimitAttributionBinding = {
  witness: string | undefined
  launchFence: number | undefined
  runtimeFence: number | undefined
}

type AttributionHost = Pick<StructuredAgentSessionHostDeps, 'usageLimitAutoContinue'> & {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
}

export function usageLimitAttributionBindingHolds(
  id: string,
  host: AttributionHost,
  binding: UsageLimitAttributionBinding | undefined
): boolean {
  const record = host.store.getRecord(id)
  return (
    binding !== undefined &&
    record !== null &&
    host.usageLimitAutoContinue?.accountWitness?.(record.provider) === binding.witness &&
    record.lease?.runtimeFence === binding.runtimeFence &&
    record.launchedAccount?.fence === binding.launchFence
  )
}

type Relaunch = {
  cut: string
  to: AgentSessionAccountHome
  fence: number | undefined
  at: number
  /** The newest reading seen since the relaunch; an older one arriving later never speaks. */
  seenAt?: number
  /** The first room of the current unbroken run of room readings, and the account it read. */
  room?: { at: number; account: string }
}

/** Cuts whose account is unknown after a relaunch. The account the chat starts on now may not be the
 *  one the cut hit, so room in its live reading, taken since this launch was first seen, releases
 *  the cut before its own reset. Derived each pass from readings; nothing is saved. */
export class UsageLimitRelaunchedCuts {
  private readonly relaunches = new Map<string, Relaunch>()
  private readonly switchReads = new Set<string>()

  /** `to` is where the chat would start now, after the launch at `fence`; null when the cut's launch
   *  still names its account. */
  note(
    id: string,
    cut: string,
    to: AgentSessionAccountHome | null,
    fence: number | undefined,
    now: number
  ): boolean {
    const current = this.relaunches.get(id)
    if (!to) {
      this.relaunches.delete(id)
      return false
    } else if (
      current?.cut !== cut ||
      current.fence !== fence ||
      !sameAccountHome(current.to, to)
    ) {
      // As with a move: only a reading taken after this launch was first seen speaks for it.
      this.relaunches.set(id, { cut, to, fence, at: now })
      return true
    }
    return false
  }

  at(id: string, cut: string): number | undefined {
    const relaunch = this.relaunches.get(id)
    return relaunch?.cut === cut ? relaunch.at : undefined
  }

  askForRoom(
    id: string,
    cut: NativeChatUsageLimitCut & SwitchReset,
    provider: string | undefined,
    witness: string | undefined,
    scope: UsageLimitAccountScope | undefined
  ): void {
    if (
      cut.resetFromSwitch !== true ||
      !provider ||
      !scope ||
      this.at(id, switchFreeIdentity(cut)) === undefined
    ) {
      return
    }
    const key = JSON.stringify([provider, witness, scope.scope])
    if (this.switchReads.has(key)) {
      return
    }
    const ask = scope.account?.refresh ?? scope.bootstrap
    if (ask?.()) {
      this.switchReads.add(key)
    }
  }

  /** When room released the cut, while the live reading of `account` still shows it: the first
   *  room of the current run, inside the overdue window. Anything else falls back to the cut's
   *  own reset: no usable reading, an older one, spending, or no windows to show room. */
  roomAt(
    id: string,
    cut: string,
    account: string | undefined,
    reading: ProviderRateLimits | null | undefined,
    now: number
  ): number | undefined {
    const relaunch = this.relaunches.get(id)
    if (
      relaunch?.cut !== cut ||
      account === undefined ||
      reading?.status !== 'ok' ||
      reading.usageMetadata?.source === 'live-session' ||
      reading.updatedAt < Math.max(relaunch.at, relaunch.seenAt ?? Number.NEGATIVE_INFINITY)
    ) {
      return undefined
    }
    relaunch.seenAt = reading.updatedAt
    if (!rateLimitShowsRoom(reading)) {
      relaunch.room = undefined
      return undefined
    }
    if (
      relaunch.room?.account !== account ||
      reading.updatedAt - relaunch.room.at > NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS
    ) {
      relaunch.room = { at: reading.updatedAt, account }
    }
    return now - relaunch.room.at <= NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS
      ? relaunch.room.at
      : undefined
  }

  retain(shown: ReadonlySet<string>): void {
    for (const id of this.relaunches.keys()) {
      if (!shown.has(id)) {
        this.relaunches.delete(id)
      }
    }
  }

  forget(id: string): void {
    this.relaunches.delete(id)
  }

  clear(): void {
    this.relaunches.clear()
    this.switchReads.clear()
  }
}
