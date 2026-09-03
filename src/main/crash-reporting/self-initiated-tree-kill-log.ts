import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import {
  setProcessTreeKillObserver,
  type ProcessTreeKillScope
} from '../../shared/child-process/process-tree-kill-observer'
import { recordCoalescedDurableCrashBreadcrumb } from './durable-crash-breadcrumb'

/**
 * Records the force-kills Orca itself issues, so a later `render-process-gone`
 * can say whether we were holding the knife.
 *
 * Why: on Windows a `taskkill /T /F` we issue and an external one produce the
 * identical `reason=killed exitCode=1` plus the identical concurrent sibling
 * deaths — reproduced side by side on Windows 11 / Electron 43.4.1, differing in
 * zero recorded fields. This is the field that separates them.
 *
 * Coverage — read this before drawing a conclusion from a zero count.
 *
 * The ring is per-process and its only reader is `process-gone-recorder`, which
 * exists in Electron main. So a count reported on a `render-process-gone` covers
 * kills issued *from Electron main*, and nothing else:
 * - Main only: the three `taskkill /T /F` families that gate on
 *   `admitSelfInitiatedTreeKill` (`terminateWindowsProcessTree` and the codex /
 *   claude account-login teardowns) and the codex app-server POSIX group
 *   teardowns.
 * - Main *and* other hosts: `signalProcessTree` (the `runProcess` choke point,
 *   reached from the CLI, relay and daemon too — a fourth pid-addressed
 *   `taskkill` family, gated on the child not being reaped rather than on the
 *   Chromium set it cannot read), the POSIX PTY process-group sweep and the
 *   Windows PTY Job Object (relay `pty-handler`, daemon
 *   `subprocess-handle`). When those run outside main they record into that
 *   process's own ring, which nothing reads — no observer is installed there,
 *   and the tracer sink is a no-op.
 * - Never instrumented: the direct `process.kill(-pid)` calls in the browser
 *   routes, notebooks, automation prechecks and ephemeral-VM recipes.
 *
 * A daemon or relay kill missing from the count is a diagnostics gap, not a
 * missed suspect: those hosts cannot reach a Chromium pid in the first place
 * (see `orca-chromium-process-pids.ts`). Absence is evidence, not proof.
 */

/** Which mechanism issued the kill; each has a different blast radius. */
export type SelfInitiatedTreeKillScope = ProcessTreeKillScope | 'win-pty-job'

export type SelfInitiatedTreeKill = {
  pid: number
  site: string
  scope: SelfInitiatedTreeKillScope
  at: number
}

// Why 32 and not the sibling ring's 16: one teardown fans out over every root of
// a codex turn, so a single incident can spend a dozen entries on its own.
const MAX_TRACKED_SELF_KILLS = 32

// Why asymmetric: a kill older than this cannot plausibly explain the death,
// while the forward edge mirrors SIBLING_DEATH_LOOKAHEAD_MS — a kill issued just
// after the renderer died is at least as likely to be teardown reacting to it.
export const SELF_TREE_KILL_LOOKBACK_MS = 5_000
export const SELF_TREE_KILL_LOOKAHEAD_MS = 250

// Why a longer window for group/job kills: those are routine teardown (three
// process groups per terminal close), and uncoalesced they evict the whole
// 30-slot breadcrumb ring — including this module's own refusal crumb.
const GROUP_KILL_COALESCE_MS = 60_000

// Same truncation rule as MAX_SIBLING_DEATHS_DETAIL_LENGTH: drop whole entries
// rather than let sanitizeCrashReportDetails cut the list mid-token.
const MAX_SELF_TREE_KILLS_DETAIL_LENGTH = 200

let selfInitiatedKills: SelfInitiatedTreeKill[] = []

/**
 * Whether the kill was addressed by pid and so could have reached a process
 * Orca did not put in its target: `taskkill /T /F` walks whatever tree the pid
 * owns at kill time, including a recycled pid that is now our renderer. A
 * process group or Job Object contains only what Orca placed there, so it is
 * structurally incapable of taking a Chromium process with it.
 */
function isPidAddressedTreeKill(scope: SelfInitiatedTreeKillScope): boolean {
  return scope === 'win-taskkill-tree'
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
  if (selfInitiatedKills.length > MAX_TRACKED_SELF_KILLS) {
    selfInitiatedKills = selfInitiatedKills.slice(-MAX_TRACKED_SELF_KILLS)
  }
  // Durable so it survives into the diagnostic bundle even when the kill takes
  // the reporting renderer with it; coalesced because the crash detail above is
  // the primary record and a teardown burst must not cost 30 ring slots plus a
  // forced disk flush each. The newest pid still rides the emitted crumb.
  recordCoalescedDurableCrashBreadcrumb({
    name: 'self_tree_kill',
    data: { pid, site, scope },
    coalesceKey: `${scope}\u0000${site}`,
    minIntervalMs: isPidAddressedTreeKill(scope)
      ? SELF_TREE_KILL_LOOKBACK_MS
      : GROUP_KILL_COALESCE_MS
  })
}

/**
 * A tree-kill we refused because the target is one of our own Chromium
 * processes. Falsifiable on purpose: this crumb appearing in a field bundle is
 * direct proof that Orca was about to kill its own renderer.
 */
export function recordRefusedOwnChromiumTreeKill(target: {
  pid: number
  site: string
  scope: SelfInitiatedTreeKillScope
}): void {
  // Coalesced per pid so a retry loop cannot flood the ring, but a distinct
  // victim pid always gets its own crumb — that pid is the whole artifact.
  recordCoalescedDurableCrashBreadcrumb({
    name: 'self_tree_kill_refused_own_chromium',
    data: target,
    coalesceKey: `${target.site}\u0000${target.pid}`,
    minIntervalMs: SELF_TREE_KILL_LOOKBACK_MS
  })
}

/** Routes the `runProcess` choke point's kills here; shared code cannot import us. */
export function installProcessTreeKillBreadcrumbObserver(): void {
  setProcessTreeKillObserver((kill) => recordSelfInitiatedTreeKill(kill))
}

export function findSelfInitiatedTreeKills(at: number): SelfInitiatedTreeKill[] {
  return selfInitiatedKills.filter((kill) => {
    const offsetMs = kill.at - at
    return offsetMs >= -SELF_TREE_KILL_LOOKBACK_MS && offsetMs <= SELF_TREE_KILL_LOOKAHEAD_MS
  })
}

// Why not `site:pid@offset`: sanitizeCrashReportString reads `word:word@` as a
// credential URL and redacts the whole token. Mirror describeChildDeath instead.
function describeSelfInitiatedTreeKill(kill: SelfInitiatedTreeKill, goneAt: number): string {
  const offsetMs = kill.at - goneAt
  return `${kill.scope}/${kill.site}/pid${kill.pid} ${offsetMs >= 0 ? '+' : ''}${offsetMs}ms`
}

/**
 * Kills Orca issued near `goneAt`, split by whether the mechanism could have
 * reached a Chromium process at all — `selfInitiatedTreeKillCount` is the
 * discriminating one, and a pty-scoped sweep must never inflate it. Empty when
 * no instrumented choke point fired; see the module doc for what that omits.
 */
export function selfInitiatedTreeKillDetails(
  goneAt: number
): Record<string, CrashReportDetailValue> {
  const kills = findSelfInitiatedTreeKills(goneAt)
  if (kills.length === 0) {
    return {}
  }
  const treeKillCount = kills.filter((kill) => isPidAddressedTreeKill(kill.scope)).length
  const described = [...kills]
    // Pid-addressed kills first: truncation must never drop the ones that could
    // have caused the death in favour of routine teardown noise.
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
