// Why: the preview proxy resolves routes per incoming request; a raw scan per
// request would hammer /proc (or lsof) under asset bursts, so scans are cached
// briefly and coalesced. A route miss forces one fresh scan before 404ing —
// dev servers appear between scan ticks.
import type { WorkspacePort } from '../../shared/workspace-ports'
import { scanWorkspacePortProbes } from './workspace-port-ownership'
import {
  advertisedLoopbackPort,
  buildPreviewLabels,
  isPreviewablePort,
  type PreviewWorktreeDescriptor
} from './worktree-preview-routes'

const DEFAULT_ROUTE_CACHE_TTL_MS = 2_000
/** Why: a flood of misses (auth `open`, unknown labels) would otherwise chain
 *  back-to-back fresh scans against /proc or lsof; a fresh request within this
 *  window reuses the just-built index instead. */
const DEFAULT_FRESH_MIN_INTERVAL_MS = 500

export type PreviewRouteTarget = {
  port: number
  /** Host a proxy on this machine can connect to (scan's normalized connect host). */
  connectHost: string
}

export type PreviewRouteEntry = {
  worktreeId: string
  label: string
  displayName: string
  /** Port the bare `<label>` host routes to: the advertised port, else the only
   *  detected port. Null when 0 or 2+ ports and none advertised. */
  primaryPort: number | null
  ports: PreviewRouteTarget[]
}

export type PreviewRouteIndex = Map<string, PreviewRouteEntry>

export type PreviewRouteResolver = (options?: { fresh?: boolean }) => Promise<PreviewRouteIndex>

export function createPreviewRouteResolver(options: {
  descriptors: () => Promise<PreviewWorktreeDescriptor[]>
  ttlMs?: number
  freshMinIntervalMs?: number
  now?: () => number
}): PreviewRouteResolver {
  const ttlMs = options.ttlMs ?? DEFAULT_ROUTE_CACHE_TTL_MS
  const freshMinIntervalMs = options.freshMinIntervalMs ?? DEFAULT_FRESH_MIN_INTERVAL_MS
  const now = options.now ?? Date.now
  let cached: { index: PreviewRouteIndex; at: number } | null = null
  let inFlight: Promise<PreviewRouteIndex> | null = null

  return async ({ fresh = false } = {}) => {
    const maxAgeMs = fresh ? freshMinIntervalMs : ttlMs
    if (cached && now() - cached.at < maxAgeMs) {
      return cached.index
    }
    if (inFlight) {
      return inFlight
    }
    inFlight = buildIndex(options.descriptors)
      .then((index) => {
        cached = { index, at: now() }
        return index
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }
}

async function buildIndex(
  descriptors: () => Promise<PreviewWorktreeDescriptor[]>
): Promise<PreviewRouteIndex> {
  const resolved = await descriptors()
  const labels = buildPreviewLabels(resolved)
  const scan = await scanWorkspacePortProbes(
    resolved.map((descriptor) => ({
      id: descriptor.worktreeId,
      repoId: descriptor.repoId,
      displayName: descriptor.worktreeName,
      path: descriptor.worktreePath
    }))
  )

  const index: PreviewRouteIndex = new Map()
  for (const descriptor of resolved) {
    const label = labels.get(descriptor.worktreeId)
    if (!label) {
      continue
    }
    index.set(label, {
      worktreeId: descriptor.worktreeId,
      label,
      displayName: descriptor.worktreeName,
      primaryPort: null,
      ports: []
    })
  }

  const advertisedByWorktree = new Map<string, number>()
  for (const port of scan.ports) {
    if (!isPreviewablePort(port)) {
      continue
    }
    const label = labels.get(port.owner.worktreeId)
    const entry = label ? index.get(label) : undefined
    if (!entry) {
      continue
    }
    if (!entry.ports.some((existing) => existing.port === port.port)) {
      entry.ports.push({ port: port.port, connectHost: connectHostForTarget(port) })
    }
    if (advertisedLoopbackPort(port) === port.port) {
      advertisedByWorktree.set(port.owner.worktreeId, port.port)
    }
  }

  for (const entry of index.values()) {
    entry.ports.sort((a, b) => a.port - b.port)
    const advertised = advertisedByWorktree.get(entry.worktreeId)
    entry.primaryPort = advertised ?? (entry.ports.length === 1 ? entry.ports[0].port : null)
  }
  return index
}

function connectHostForTarget(port: WorkspacePort): string {
  // Why: the scanner normalizes wildcard binds to `localhost`; a listener bound
  // to one concrete address must be dialed on that address.
  return port.connectHost || 'localhost'
}
