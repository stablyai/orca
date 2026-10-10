/**
 * How many offscreen browser tabs a headless runtime may hold open at once.
 *
 * Why a cap exists at all: every offscreen tab is a BrowserWindow with its own
 * renderer process, and on a headless `orca serve` nothing reclaims one an agent
 * forgot to close — there is no window to reveal the growth either. #14552
 * measured a single working day reaching 9 open tabs backed by 6 renderers of
 * 220-480 MB each on a 4 vCPU / 8 GB host: 6.85 load average, 2.5 GB of swap in
 * use, and a paired client that reported only "Reconnecting to remote runtime".
 *
 * Why 4: any default of 6 or more still admits the renderer count that was
 * already saturating that host, so the cap has to sit under it. Four renderers
 * bound the browser near 1.9 GB at the measured per-renderer high-water mark
 * while still leaving an agent room to hold one page open and compare it against
 * another. Hosts with more memory raise it through the environment override.
 */
export const DEFAULT_MAX_OFFSCREEN_BROWSER_TABS = 4

export const MAX_OFFSCREEN_BROWSER_TABS_ENV = 'ORCA_MAX_OFFSCREEN_BROWSER_TABS'

/** The error code a create refused for capacity carries to the CLI. */
export const OFFSCREEN_BROWSER_TAB_CAPACITY_CODE = 'browser_tab_capacity'

// Why an upper bound on the override: past this the value is a typo, not an
// intent — 64 renderers outweigh any host this backend runs on, and silently
// honoring it would restore exactly the unbounded growth the cap exists to stop.
const MAX_CONFIGURABLE_OFFSCREEN_BROWSER_TABS = 64

/** Reads the per-host override, falling back to the default for anything unusable. */
export function resolveOffscreenBrowserTabCap(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env[MAX_OFFSCREEN_BROWSER_TABS_ENV])
  if (!Number.isInteger(configured) || configured < 1) {
    return DEFAULT_MAX_OFFSCREEN_BROWSER_TABS
  }
  return Math.min(configured, MAX_CONFIGURABLE_OFFSCREEN_BROWSER_TABS)
}

/** Names the cap and the way out, because the agent that hit it is the one that must close a tab. */
export function offscreenBrowserTabCapacityMessage(openTabs: number, maxTabs: number): string {
  return (
    `This runtime already holds ${openTabs} open browser tabs (limit ${maxTabs}). ` +
    'Close one with `orca tab close --page <id>` and retry, or raise ' +
    `${MAX_OFFSCREEN_BROWSER_TABS_ENV} on the runtime host.`
  )
}
