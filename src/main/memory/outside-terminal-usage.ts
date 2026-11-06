import { collectSubtree, type ProcIndex } from './process-index'
import { readProcessPaneIdentities, type ProcessPaneIdentity } from './process-pane-identity'
import { clampMemoryMetric } from './memory-snapshot-values'

export type OutsideTerminalUsage = {
  cpu: number
  memory: number
  privateMemory: number
  pids: number[]
}

/**
 * Usage of processes a terminal started that now run outside every terminal's tree, because
 * their terminal closed or they daemonized, keyed by the workspace their pane tag names. A
 * process whose own tag is cleared or unreadable takes its nearest tagged ancestor's.
 */
export async function collectOutsideTerminalUsage(
  index: ProcIndex,
  claimed: ReadonlySet<number>,
  orcaRoots: readonly number[]
): Promise<Map<string, OutsideTerminalUsage>> {
  const skipped = new Set(claimed)
  for (const root of orcaRoots) {
    for (const pid of collectSubtree(index, root)) {
      skipped.add(pid)
    }
  }
  const candidates = [...index.byPid.keys()].filter((pid) => pid > 1 && !skipped.has(pid))
  const identities = await readProcessPaneIdentities(candidates)
  // Orca started from one of its own terminals inherits that pane's tag, and so do its helpers.
  const inheritedPaneKey = process.env.ORCA_PANE_KEY || null
  const resolved = new Map<number, ProcessPaneIdentity | null>()

  const identityOf = (pid: number): ProcessPaneIdentity | null => {
    const path: number[] = []
    let identity: ProcessPaneIdentity | null = null
    for (let current = pid; ;) {
      const known = resolved.get(current)
      if (known !== undefined) {
        identity = known
        break
      }
      path.push(current)
      const own = identities.get(current)
      if (own && (inheritedPaneKey === null || own.paneKey !== inheritedPaneKey)) {
        identity = own
        break
      }
      const parent = index.byPid.get(current)?.ppid
      if (
        parent === undefined ||
        parent <= 1 ||
        skipped.has(parent) ||
        !index.byPid.has(parent) ||
        path.includes(parent)
      ) {
        break
      }
      current = parent
    }
    for (const visited of path) {
      resolved.set(visited, identity)
    }
    return identity
  }

  const usage = new Map<string, OutsideTerminalUsage>()
  for (const pid of candidates) {
    const identity = identityOf(pid)
    const row = index.byPid.get(pid)
    if (!identity || !row) {
      continue
    }
    let entry = usage.get(identity.worktreeId)
    if (!entry) {
      entry = { cpu: 0, memory: 0, privateMemory: 0, pids: [] }
      usage.set(identity.worktreeId, entry)
    }
    entry.cpu += row.cpu
    entry.memory += row.memory
    entry.privateMemory += clampMemoryMetric(row.privateMemory)
    entry.pids.push(pid)
  }
  for (const entry of usage.values()) {
    entry.pids.sort((a, b) => a - b)
  }
  return usage
}
