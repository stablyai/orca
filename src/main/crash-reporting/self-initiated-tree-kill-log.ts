import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import type { ProcessTreeKillScope } from '@orca/process-host/process-tree-kill-gate'
import { recordCoalescedDurableCrashBreadcrumb } from './durable-crash-breadcrumb'

// Reports see only kills recorded in Electron main; remote-host rings and uninstrumented paths are absent.
// An empty count does not prove Orca issued no kill.

export type SelfInitiatedTreeKillScope = ProcessTreeKillScope | 'win-pty-job'

export type SelfInitiatedTreeKill = {
  pid: number
  site: string
  scope: SelfInitiatedTreeKillScope
  at: number
}

// Window close can burst past 30 group kills, so retain more than the sibling ring.
const MAX_TRACKED_SELF_KILLS = 32

// Allow recent causes more lookback; later kills may be teardown reacting to the death.
export const SELF_TREE_KILL_LOOKBACK_MS = 5_000
export const SELF_TREE_KILL_LOOKAHEAD_MS = 250

// Coalesce routine group/job teardown so bursts cannot flood breadcrumbs and forced disk flushes.
const GROUP_KILL_COALESCE_MS = 60_000

// Drop whole entries before the generic detail cap can truncate a token.
const MAX_SELF_TREE_KILLS_DETAIL_LENGTH = 200

let selfInitiatedKills: SelfInitiatedTreeKill[] = []

// A recycled PID can redirect taskkill; groups and jobs contain only their assigned processes.
function isPidAddressedTreeKill(scope: SelfInitiatedTreeKillScope): boolean {
  return scope === 'win-taskkill-tree'
}

// Preserve the newest evidence; evict older group/job teardown before PID-addressed kills.
function evictOneSelfInitiatedTreeKill(): void {
  const lastCandidate = selfInitiatedKills.length - 1
  const oldestGroupKill = selfInitiatedKills.findIndex(
    (kill, index) => index < lastCandidate && !isPidAddressedTreeKill(kill.scope)
  )
  selfInitiatedKills.splice(Math.max(oldestGroupKill, 0), 1)
}

export function recordSelfInitiatedTreeKill({
  pid,
  site,
  scope,
  at = Date.now()
}: {
  pid: number
  site: string
  scope: SelfInitiatedTreeKillScope
  at?: number
}): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }
  selfInitiatedKills.push({ pid, site, scope, at })
  while (selfInitiatedKills.length > MAX_TRACKED_SELF_KILLS) {
    evictOneSelfInitiatedTreeKill()
  }
  // Durable spans survive renderer kills; details retain individual kills from coalesced bursts.
  recordCoalescedDurableCrashBreadcrumb({
    name: 'self_tree_kill',
    data: { pid, site, scope },
    coalesceKey: `${scope}\u0000${site}`,
    minIntervalMs: isPidAddressedTreeKill(scope)
      ? SELF_TREE_KILL_LOOKBACK_MS
      : GROUP_KILL_COALESCE_MS
  })
}

/** Record a refused attempt to target Orca's own Chromium process. */
export function recordRefusedOwnChromiumTreeKill(target: {
  pid: number
  site: string
  scope: SelfInitiatedTreeKillScope
}): void {
  // Coalesce retries by PID while keeping distinct targets separate.
  recordCoalescedDurableCrashBreadcrumb({
    name: 'self_tree_kill_refused_own_chromium',
    data: target,
    coalesceKey: `${target.site}\u0000${target.pid}`,
    minIntervalMs: SELF_TREE_KILL_LOOKBACK_MS
  })
}

export function findSelfInitiatedTreeKills(at: number): SelfInitiatedTreeKill[] {
  return selfInitiatedKills.filter((kill) => {
    const offsetMs = kill.at - at
    return offsetMs >= -SELF_TREE_KILL_LOOKBACK_MS && offsetMs <= SELF_TREE_KILL_LOOKAHEAD_MS
  })
}

// Avoid site:pid@offset: the report redactor mistakes it for credential-bearing URLs.
function describeSelfInitiatedTreeKill(kill: SelfInitiatedTreeKill, goneAt: number): string {
  const offsetMs = kill.at - goneAt
  return `${kill.scope}/${kill.site}/pid${kill.pid} ${offsetMs >= 0 ? '+' : ''}${offsetMs}ms`
}

/** Nearby Electron-main kills, split by whether their mechanism targets a PID or a group/job. */
export function selfInitiatedTreeKillDetails(
  goneAt: number
): Record<string, CrashReportDetailValue> {
  const kills = findSelfInitiatedTreeKills(goneAt)
  if (kills.length === 0) {
    return {}
  }
  const treeKillCount = kills.filter((kill) => isPidAddressedTreeKill(kill.scope)).length
  const described = [...kills]
    // Prioritize PID-addressed kills so truncation preserves potential renderer-kill evidence.
    .sort((a, b) => {
      const reach =
        Number(isPidAddressedTreeKill(b.scope)) - Number(isPidAddressedTreeKill(a.scope))
      return reach !== 0 ? reach : Math.abs(a.at - goneAt) - Math.abs(b.at - goneAt)
    })
    .map((kill) => describeSelfInitiatedTreeKill(kill, goneAt))
  const kept: string[] = []
  for (const entry of described) {
    if (kept.length > 0 && [...kept, entry].join(', ').length > MAX_SELF_TREE_KILLS_DETAIL_LENGTH) {
      break
    }
    kept.push(entry.slice(0, MAX_SELF_TREE_KILLS_DETAIL_LENGTH))
  }
  const dropped = described.length - kept.length
  return {
    ...(treeKillCount > 0 ? { selfInitiatedTreeKillCount: treeKillCount } : {}),
    ...(kills.length - treeKillCount > 0
      ? { selfInitiatedGroupKillCount: kills.length - treeKillCount }
      : {}),
    selfInitiatedKills: dropped > 0 ? `${kept.join(', ')} (+${dropped} more)` : kept.join(', ')
  }
}

export function resetSelfInitiatedTreeKillLogForTest(): void {
  selfInitiatedKills = []
}
