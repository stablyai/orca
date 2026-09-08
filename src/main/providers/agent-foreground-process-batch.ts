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
  /** Set only when the table was readable: every process group attached to this PTY's terminal is
   *  the shell's own, none of them is stopped, AND that group's only member is the shell itself.
   *  Left absent when we could not observe it. Keeps the tty-shaped name because it is on the wire
   *  (`ForegroundProcessEvidence`); the value only ever got stricter, so an old client reading it
   *  skips more, never less. */
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

/** The two units a forced stop can reach, indexed from one capture: which process groups occupy
 *  each controlling terminal (which terminals hold a stopped process), and how many rows belong to
 *  each process group anywhere on the host. */
type PaneOccupancy = {
  processGroupsByTty: ReadonlyMap<number, ReadonlySet<number>>
  stoppedTtys: ReadonlySet<number>
  /** Rows per `pgid`, counted over the WHOLE table with no tty filter — that is the point of it.
   *  A member that shares the shell's group but has no controlling terminal is reachable by
   *  `killpg` and invisible to every tty-shaped index. */
  rowsByProcessGroup: ReadonlyMap<number, number>
  /** True when some row carried no `pgid`, so the group counts are incomplete and cannot support
   *  an idleness claim. */
  processGroupsIncomplete: boolean
}

const paneOccupancyByCapture = new WeakMap<readonly ProcessTableRow[], PaneOccupancy>()

/** Index the capture by controlling terminal and by process group.
 *
 *  The tty half is keyed on `tpgid` because the snapshot carries no tty column and does not need
 *  one: a process group belongs to exactly one session, a session to at most one controlling
 *  terminal, so two rows reporting the same live `tpgid` are on the same tty. Memoized per capture,
 *  since the per-pane cadence poll and `pty.listProcesses` share one TTL-cached table. */
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
    // The only host-observable "nothing is running here" signal, and it takes TWO measurements
    // because the stop it authorizes has two units. `forceKillPosixPtyProcessGroups` collects every
    // process group on the pane's tty and then `killpg`s each one, so the blast radius is
    // (groups on the tty) x (members of those groups, wherever they are). Neither half implies the
    // other, so both are required:
    //
    //   tty:   a backgrounded `pnpm build &` and a Ctrl-Z'd editor both hand the terminal back, so
    //          the shell's row is byte-identical to an idle prompt. What separates them is a second
    //          process group attached to the pane's terminal.
    //   group: with job control off (`set +m`, common in non-interactive and dumb-terminal shells,
    //          and settable by the user at the prompt) a background job KEEPS the shell's pgid, so
    //          the tty shows one group and that group is running a build. Same for a child that
    //          drops the controlling terminal without `setsid` (`tpgid == -1`, absent from every
    //          tty index, still reachable by `killpg`) and for a double-forked grandchild that
    //          reparents to pid 1 and so never appears in the ppid walk below.
    //
    // Residual after both, written down because the predicate cannot see it: the capture is a
    // snapshot, so work started between the `ps` and the signal is invisible — bounded, not
    // removed, by RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS on the reading side; and a process the host's
    // own `ps` cannot enumerate (another PID namespace, `hidepid=2`, a table truncated by a
    // permission boundary) is unobservable here while `killpg` still reaches it.
    //
    // A reader may treat `false` as "busy" and must never treat absence as "idle".
    const ttyProcessGroups = occupancy.processGroupsByTty.get(root.tpgid)
    const shellOwnsEveryTtyProcessGroup =
      root.tpgid === root.pgid &&
      ttyProcessGroups !== undefined &&
      ttyProcessGroups.size === 1 &&
      ttyProcessGroups.has(root.pgid) &&
      !occupancy.stoppedTtys.has(root.tpgid) &&
      !occupancy.processGroupsIncomplete &&
      // The root always counts itself, so exactly one row in its group means the group IS the
      // shell — no separate leader check, and no set of pids retained per capture.
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
