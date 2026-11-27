import { isCommandAvailable } from '../ipc/preflight/preflight-command-exec'
import type { WslPreflightTarget } from '../ipc/preflight/preflight-wsl-agent-detection'
import { prunePreflightWslCache } from '../wsl/discovery/preflight-wsl-cache'
import { assertWslDistroRunningForExec } from '../wsl/discovery/wsl-background-exec-gate'

export type GlabStatus = { installed: boolean; authenticated: boolean }
type GlabAuthProbe = (probe: { wslTarget: WslPreflightTarget }) => Promise<boolean>

// Covers misses of the distro's full preflight entry only, which owns the answer whenever it is fresh.
// A full entry costs 5 wsl.exe launches plus host provider checks; glab alone needs 2.
const GLAB_ONLY_TTL_MS = 30_000
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

/** glab in `distro`; rejects while the distro is stopped, and caches nothing for that. */
export async function readGlabOnly(
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
      glabOnlyByDistro.set(distro, { glab, expiresAt: Date.now() + GLAB_ONLY_TTL_MS })
    }
    return glab
  } finally {
    if (glabOnlyInFlight.get(distro) === run) {
      glabOnlyInFlight.delete(distro)
    }
  }
}
