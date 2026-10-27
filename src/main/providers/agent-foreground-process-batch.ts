import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess
} from '../../shared/agent-process-recognition'
import { getFirstCommandToken } from '../../shared/command-token-scanner'
import { resolveOuterWrapperForegroundProcess } from '../../shared/foreground-wrapper-agent'
import { selectForegroundProcessCandidate } from '../../shared/foreground-process-selection'
import type {
  ForegroundProcessEvidence,
  RemoteForegroundEvidence
} from '../../shared/foreground-process-evidence'
import {
  buildProcessTableIndex,
  lookupProcessTableIndex,
  type ProcessTableIndex,
  type ProcessTableIndexStats
} from '../../shared/process-table-index'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { getStrictProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import { resolveRemoteForegroundEvidenceFromRows } from './agent-foreground-process-remote-evidence'

export type BatchedForegroundProcessRequest = {
  rootPid: number
  fallbackProcess?: string | null
}

export type BatchedForegroundProcessResult = {
  available: boolean
  processName: string | null
  reason?: string
  /** True only for a readable table with no other tty groups/stopped processes and the shell alone in its group.
   * Keep the wire name for old clients; stricter proof can only reduce skipped sweeps. */
  shellOwnsEveryTtyProcessGroup?: boolean
}

export type RemoteForegroundEvidenceOptions = {
  ptyId: string
  ptyIncarnationId: string
  authorityGeneration: string
  observationEpoch: number
  capturedAgeMs: number
  platform?: NodeJS.Platform
}

/** Resolve a host-stamped, fenced observation from one complete process-table capture. */
export function resolveRemoteForegroundEvidence(
  request: BatchedForegroundProcessRequest,
  options: RemoteForegroundEvidenceOptions,
  rows: readonly ProcessTableRow[]
): RemoteForegroundEvidence {
  return resolveRemoteForegroundEvidenceFromRows(
    request,
    options,
    rows,
    resolveAgentForegroundProcessesFromIndex
  )
}

export type BatchedForegroundProcessOptions = {
  rows?: readonly ProcessTableRow[]
  readRows?: () => Promise<readonly ProcessTableRow[]>
  stats?: ProcessTableIndexStats
}

type PaneOccupancy = {
  processGroupsByTty: ReadonlyMap<number, ReadonlySet<number>>
  stoppedTtys: ReadonlySet<number>
  /** Count all group members: killpg also reaches members without a controlling terminal. */
  rowsByProcessGroup: ReadonlyMap<number, number>
  /** Missing pgid rows make group counts insufficient to prove idle. */
  processGroupsIncomplete: boolean
}

const paneOccupancyByCapture = new WeakMap<readonly ProcessTableRow[], PaneOccupancy>()

/** A live tpgid identifies one controlling terminal; memoize its groups and host-wide group sizes per shared capture. */
function getPaneOccupancy(rows: readonly ProcessTableRow[]): PaneOccupancy {
  const cached = paneOccupancyByCapture.get(rows)
  if (cached) {
    return cached
  }
  const processGroupsByTty = new Map<number, Set<number>>()
  const stoppedTtys = new Set<number>()
  const rowsByProcessGroup = new Map<number, number>()
  let processGroupsIncomplete = false
  for (const row of rows) {
    if (row.pgid === undefined) {
      processGroupsIncomplete = true
      continue
    }
    rowsByProcessGroup.set(row.pgid, (rowsByProcessGroup.get(row.pgid) ?? 0) + 1)
    if (row.tpgid === undefined || row.tpgid <= 0) {
      continue
    }
    let groups = processGroupsByTty.get(row.tpgid)
    if (!groups) {
      groups = new Set<number>()
      processGroupsByTty.set(row.tpgid, groups)
    }
    groups.add(row.pgid)
    // `T` is a job-control stop (Ctrl-Z), `t` a tracing stop. Both are work the pane still holds.
    if (row.stat.startsWith('T') || row.stat.startsWith('t')) {
      stoppedTtys.add(row.tpgid)
    }
  }
  const occupancy: PaneOccupancy = {
    processGroupsByTty,
    stoppedTtys,
    rowsByProcessGroup,
    processGroupsIncomplete
  }
  paneOccupancyByCapture.set(rows, occupancy)
  return occupancy
}

export async function resolveAgentForegroundProcessesBatch(
  requests: readonly BatchedForegroundProcessRequest[],
  options: BatchedForegroundProcessOptions = {}
): Promise<BatchedForegroundProcessResult[]> {
  let rows = options.rows
  if (!rows) {
    if (options.stats) {
      options.stats.captures = (options.stats.captures ?? 0) + 1
    }
    rows = await (options.readRows?.() ?? getStrictProcessTableSnapshot())
  }
  const index = buildProcessTableIndex(rows, options.stats)
  return resolveAgentForegroundProcessesFromIndex(index, requests)
}

export function resolveAgentForegroundProcessesFromIndex(
  index: ProcessTableIndex,
  requests: readonly BatchedForegroundProcessRequest[]
): BatchedForegroundProcessResult[] {
  const uniqueRoots = new Set<number>()
  for (const request of requests) {
    uniqueRoots.add(request.rootPid)
  }
  const rootsByPid = new Set(uniqueRoots)
  const depthByPid = new Map<number, number>()
  const rowsByOwner = new Map<number, (ProcessTableRow & { depth: number })[]>()
  const queue: { row: ProcessTableRow; owner: number; depth: number }[] = []
  for (const rootPid of uniqueRoots) {
    const root = lookupProcessTableIndex(index, (value) => value.byPid.get(rootPid))
    if (root) {
      depthByPid.set(root.pid, 0)
      queue.push({ row: root, owner: root.pid, depth: 0 })
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    const owned = rowsByOwner.get(current.owner) ?? []
    if (current.depth > 0) {
      owned.push({ ...current.row, depth: current.depth })
    }
    rowsByOwner.set(current.owner, owned)
    const children = lookupProcessTableIndex(
      index,
      (value) => value.childrenByPpid.get(current.row.pid) ?? []
    )
    for (const child of children) {
      const childOwner = rootsByPid.has(child.pid) ? child.pid : current.owner
      const childDepth = rootsByPid.has(child.pid) ? 0 : current.depth + 1
      const priorDepth = depthByPid.get(child.pid)
      if (priorDepth !== undefined && priorDepth <= childDepth) {
        continue
      }
      depthByPid.set(child.pid, childDepth)
      queue.push({ row: child, owner: childOwner, depth: childDepth })
    }
  }

  const occupancy = getPaneOccupancy(index.rows)
  return requests.map((request) => {
    const root = lookupProcessTableIndex(index, (value) => value.byPid.get(request.rootPid))
    if (!root) {
      return {
        available: false,
        processName: request.fallbackProcess ?? null,
        reason: 'root_missing'
      }
    }
    if (root.pgid === undefined || root.tpgid === undefined) {
      return {
        available: false,
        processName: request.fallbackProcess ?? null,
        reason: 'correlation_unavailable'
      }
    }
    if (root.tpgid === 0 || root.tpgid === -1) {
      return {
        available: false,
        processName: request.fallbackProcess ?? null,
        reason: 'no_controlling_tty'
      }
    }
    // Sweep authorization needs both: no other tty group (background/stopped jobs), and no other shell-group member
    // anywhere (job control off, detached/reparented children). Missing evidence never proves idle.
    // Capture age bounds races with new work; ps permission/namespace omissions remain unobservable despite killpg reach.
    const ttyProcessGroups = occupancy.processGroupsByTty.get(root.tpgid)
    const shellOwnsEveryTtyProcessGroup =
      root.tpgid === root.pgid &&
      ttyProcessGroups !== undefined &&
      ttyProcessGroups.size === 1 &&
      ttyProcessGroups.has(root.pgid) &&
      !occupancy.stoppedTtys.has(root.tpgid) &&
      !occupancy.processGroupsIncomplete &&
      // The root counts itself; exactly one group member excludes all other killpg targets.
      occupancy.rowsByProcessGroup.get(root.pgid) === 1
    const allCandidates = rowsByOwner.get(root.pid) ?? []
    const foregroundCandidates = allCandidates.filter((row) => row.pgid === root.tpgid)
    const fallbackProcess = request.fallbackProcess
    const wrapperFallback =
      typeof fallbackProcess === 'string' && isAgentForegroundWrapperProcess(fallbackProcess)
    const candidates = wrapperFallback
      ? foregroundCandidates.filter((candidate) =>
          isExpectedAgentProcess(getFirstCommandToken(candidate.command), fallbackProcess)
        )
      : foregroundCandidates
    if (wrapperFallback && candidates.length !== 1) {
      return { available: true, processName: null, shellOwnsEveryTtyProcessGroup }
    }
    const selected = selectForegroundProcessCandidate(candidates, allCandidates)
    if (selected) {
      return {
        available: true,
        processName: resolveOuterWrapperForegroundProcess(
          selected.recognized,
          selected.candidate,
          allCandidates
        ),
        shellOwnsEveryTtyProcessGroup
      }
    }
    return { available: true, processName: null, shellOwnsEveryTtyProcessGroup }
  })
}

export function toForegroundProcessEvidence(
  result: BatchedForegroundProcessResult,
  metadata: { authorityGeneration: string; observationEpoch: number; capturedAgeMs: number }
): ForegroundProcessEvidence {
  return result.available
    ? {
        ...metadata,
        verdict: 'live',
        processName: result.processName,
        ...(result.shellOwnsEveryTtyProcessGroup !== undefined
          ? { shellOwnsEveryTtyProcessGroup: result.shellOwnsEveryTtyProcessGroup }
          : {})
      }
    : {
        ...metadata,
        verdict: 'unverifiable',
        reason: result.reason ?? 'correlation_unavailable'
      }
}
