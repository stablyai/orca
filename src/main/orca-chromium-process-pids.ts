import { getAppEnvironment, hasAppEnvironment } from '../shared/app-environment'
import { recordCoalescedDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'

/**
 * PIDs of Orca's own Chromium processes — browser, renderers, GPU, utilities.
 *
 * Why: `taskkill /T /F` aimed at one of these kills a renderer we depend on, and
 * the `render-process-gone` it produces is indistinguishable from an external
 * kill in every field Orca records (#10680). A pid in this set is proof the
 * target is ours to keep, not ours to tear down.
 *
 * Empty on a Node host and empty on failure: that is "no refusal proven", never
 * "safe to kill" — callers must keep every other guard they already have.
 *
 * Why failure stays open rather than refusing everything: a refusal is not free.
 * `terminateWindowsProcessTree` resolves without killing, and
 * `killSourceControlAgentProcess` returns that straight to a caller that then
 * releases the managed-home lock, so failing closed would trade one unreadable
 * metrics table for every PTY, git, codex and notebook tree in main leaking at
 * once. The `own_chromium_pids_unreadable` crumb is the price of that choice:
 * without it a throw is byte-identical to "no Chromium on this host".
 *
 * Host coverage: only Electron main installs a Chromium-backed AppEnvironment
 * (main-process-preflight). The standalone daemon installs none and `orcad`
 * installs a Node one whose `getAppMetrics()` is `[]`, so this set is empty in
 * both — and that is sound, not a hole: the pid-addressed kills those hosts
 * issue go through `classifyWindowsTreeKillTarget`, which walks ancestry back to
 * the *killing* process's own pid. Orca's Chromium processes are children of
 * Electron main, so they never classify `own` from a daemon or orcad host, and
 * on an SSH/serve host there is no Chromium on the machine at all.
 */
export function readOrcaChromiumProcessPids(): ReadonlySet<number> {
  if (!hasAppEnvironment()) {
    return new Set()
  }
  try {
    const pids = getAppEnvironment()
      .getAppMetrics()
      .map((metric) => metric.pid)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
    return new Set(pids)
  } catch (error) {
    recordUnreadableOwnChromiumMetrics(error)
    return new Set()
  }
}

// Why coalesced: the gate reads this set on every tree kill, so a persistently
// broken metrics table would otherwise flood the 30-slot ring it shares.
const UNREADABLE_METRICS_COALESCE_MS = 60_000

function recordUnreadableOwnChromiumMetrics(error: unknown): void {
  try {
    recordCoalescedDurableCrashBreadcrumb({
      name: 'own_chromium_pids_unreadable',
      data: { cause: error instanceof Error ? error.message : String(error) },
      coalesceKey: 'own-chromium-pids-unreadable',
      minIntervalMs: UNREADABLE_METRICS_COALESCE_MS
    })
  } catch {
    // Diagnostics must never turn an admitted kill into a thrown one: callers
    // read this set outside their own try.
  }
}
