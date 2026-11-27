import { isCommandAvailable } from '../ipc/preflight/preflight-command-exec'
import type { WslPreflightTarget } from '../ipc/preflight/preflight-wsl-agent-detection'
import { prunePreflightWslCache } from '../wsl/discovery/preflight-wsl-cache'
import { assertWslDistroRunningForExec } from '../wsl/discovery/wsl-background-exec-gate'

export type GlabStatus = { installed: boolean; authenticated: boolean }
type GlabAuthProbe = (probe: { wslTarget: WslPreflightTarget }) => Promise<boolean>

// Cache per distro; a short TTL recovers unreachable distros whose failures appear as missing tooling.
// Shared by both caches: newest-wins precedence compares their expiries.
export const WSL_PREFLIGHT_CACHE_TTL_MS = 30_000
// Covers misses of the distro's full preflight entry only, which owns the answer whenever it is fresh.
// A full entry costs 5 wsl.exe launches plus host provider checks; glab alone needs 2.
const MAX_GLAB_ONLY_ENTRIES = 16
const glabOnlyByDistro = new Map<string, { glab: GlabStatus; expiresAt: number }>()
const glabOnlyInFlight = new Map<string, Promise<GlabStatus>>()
const latestGlabOnlyRun = new Map<string, number>()
let glabOnlyRunCounter = 0
let glabOnlyEpoch = 0

/** @internal - cleared with the main preflight cache. */
export function _resetGlabOnlyCache(): void {
  glabOnlyByDistro.clear()
  glabOnlyInFlight.clear()
  latestGlabOnlyRun.clear()
  glabOnlyEpoch += 1
}

async function probeGlabInDistro(
  distro: string,
  isGlabAuthenticated: GlabAuthProbe
): Promise<GlabStatus> {
  // Same gate as the full entry: a background read never boots a stopped distro (E9).
  await assertWslDistroRunningForExec(distro)
  const wslTarget = { distro }
  if (!(await isCommandAvailable('glab', wslTarget))) {
    return { installed: false, authenticated: false }
  }
  return { installed: true, authenticated: await isGlabAuthenticated({ wslTarget }) }
}

/** When this distro's fresh glab-only answer expires; same TTL as the full entry, so later means newer. */
function glabOnlyExpiresAt(distro: string): number {
  const entry = glabOnlyByDistro.get(distro)
  return entry && entry.expiresAt > Date.now() ? entry.expiresAt : 0
}

/**
 * glab in the default distro. The distro's full preflight entry answers while it is fresh and not
 * older than the glab-only answer; re-running it for glab alone would waste 3 launches.
 */
export async function readDefaultDistroGlab(
  distro: string,
  force: boolean,
  fullEntry: { result: { glab?: GlabStatus }; expiresAt: number } | undefined,
  isGlabAuthenticated: GlabAuthProbe
): Promise<GlabStatus> {
  const fullGlab = fullEntry?.result.glab
  if (
    !force &&
    fullGlab &&
    fullEntry.expiresAt > Date.now() &&
    fullEntry.expiresAt >= glabOnlyExpiresAt(distro)
  ) {
    return fullGlab
  }
  return readGlabOnly(distro, force, isGlabAuthenticated)
}

/** glab in `distro`; rejects while the distro is stopped, and caches nothing for that. */
async function readGlabOnly(
  distro: string,
  force: boolean,
  isGlabAuthenticated: GlabAuthProbe
): Promise<GlabStatus> {
  prunePreflightWslCache(glabOnlyByDistro, latestGlabOnlyRun, Date.now(), MAX_GLAB_ONLY_ENTRIES)
  if (!force) {
    const hit = glabOnlyByDistro.get(distro)?.glab ?? glabOnlyInFlight.get(distro)
    if (hit) {
      return hit
    }
  }
  const runId = ++glabOnlyRunCounter
  const epochAtStart = glabOnlyEpoch
  latestGlabOnlyRun.set(distro, runId)
  const run = probeGlabInDistro(distro, isGlabAuthenticated)
  glabOnlyInFlight.set(distro, run)
  try {
    const glab = await run
    // Superseded or reset probes answer their caller but cannot populate the cache.
    if (latestGlabOnlyRun.get(distro) === runId && epochAtStart === glabOnlyEpoch) {
      glabOnlyByDistro.set(distro, { glab, expiresAt: Date.now() + WSL_PREFLIGHT_CACHE_TTL_MS })
    }
    return glab
  } finally {
    if (glabOnlyInFlight.get(distro) === run) {
      glabOnlyInFlight.delete(distro)
    }
  }
}
