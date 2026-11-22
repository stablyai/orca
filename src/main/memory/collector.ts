import { getAppEnvironment, type AppEnvironment } from '../../shared/app-lifecycle/app-environment'
import type {
  AppMemory,
  MemorySnapshot,
  SessionMemory,
  UsageValues,
  WorktreeMemory
} from '../../shared/diagnostics/process-stats-types'
import { ORPHAN_WORKTREE_ID } from '../../shared/terminal/pty/orphan-worktree-id'
import { listRegisteredPtys } from './pty-registry'
import { collectHostMemory } from './host-memory'
import { getLocalDaemonPid } from './local-daemon-pid'
import { enumerateHostProcesses } from './host-process-index'
import { claimProcessTree, claimPtyProcessTrees } from './pty-process-trees'
import {
  agentRegistrationMark,
  listAgentProcessRoots,
  readAgentProcessChat
} from './agent-process-registry'
import type { ProcIndex, ProcRow } from './process-index'
import { recordPairedReplyParts } from './memory-snapshot-paired-reply'
import { recordWorkspaceMemorySeries } from './workspace-memory-series'
import {
  createEmptyWorktreeMemoryBucket,
  pushAppMemoryHistory,
  readAppMemoryHistory,
  readMemoryHistory,
  terminalOnlyHistoryKey,
  createProjectGroupNameLookup,
  createRepoNameLookup,
  resolveWorktreeMemoryNames,
  type MemorySnapshotStore,
  type WorktreeMemoryBucket
} from './memory-snapshot-buckets'
import {
  clampMemoryMetric,
  emptyMemorySnapshot,
  optionalCommitField,
  snapshotCommitFields
} from './memory-snapshot-values'

export type { MemorySnapshotStore } from './memory-snapshot-buckets'
export { collectSubtree, parsePsOutput } from './process-index'

let inflight: Promise<MemorySnapshot> | null = null

export async function collectMemorySnapshot(store: MemorySnapshotStore): Promise<MemorySnapshot> {
  // Runtime callers share one process-wide store, so coalesced sweeps use the same data source.
  if (inflight) {
    return inflight
  }
  inflight = runSnapshot(store)
    .catch((err) => {
      console.warn('[memory] snapshot failed; returning empty', err)
      return emptyMemorySnapshot()
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

type AppBucketsRaw = Omit<AppMemory, 'history'>

function electronMetricMemoryBytes(
  proc: ReturnType<AppEnvironment['getAppMetrics']>[number],
  processIndex: ProcIndex
): number {
  const hostMemory = processIndex.byPid.get(proc.pid)?.memory
  if (typeof hostMemory === 'number' && Number.isFinite(hostMemory) && hostMemory > 0) {
    return hostMemory
  }
  // Prefer host RSS over shared macOS Electron mappings; retain Electron fallback for vanished processes.
  return clampMemoryMetric(proc.memory?.workingSetSize) * 1024
}

function bucketElectronMetrics(processIndex: ProcIndex): AppBucketsRaw {
  const main = { cpu: 0, memory: 0, privateMemory: 0 }
  const renderer = { cpu: 0, memory: 0, privateMemory: 0 }
  const other = { cpu: 0, memory: 0, privateMemory: 0 }

  const electronPids = new Set<number>()
  for (const proc of getAppEnvironment().getAppMetrics()) {
    electronPids.add(proc.pid)
    const cpu = clampMemoryMetric(proc.cpu?.percentCPUUsage)
    const memoryBytes = electronMetricMemoryBytes(proc, processIndex)
    // Electron does not report helper-process commit; reuse the host sweep.
    const privateBytes = clampMemoryMetric(processIndex.byPid.get(proc.pid)?.privateMemory)

    const type = (typeof proc.type === 'string' ? proc.type : '').toLowerCase()
    let target = other
    if (type === 'browser') {
      target = main
    } else if (type === 'renderer' || type === 'tab') {
      target = renderer
    }

    target.cpu += cpu
    target.memory += memoryBytes
    target.privateMemory += privateBytes
  }

  // The terminal daemon is detached from Electron, so getAppMetrics omits it; its PTY children stay with their worktrees.
  const daemonPid = getLocalDaemonPid()
  const daemon = daemonPid === null ? undefined : processIndex.byPid.get(daemonPid)
  if (daemon && !electronPids.has(daemon.pid)) {
    other.cpu += daemon.cpu
    other.memory += daemon.memory
    other.privateMemory += clampMemoryMetric(daemon.privateMemory)
  }

  const usage = (bucket: typeof main): UsageValues => ({
    cpu: bucket.cpu,
    memory: bucket.memory,
    ...optionalCommitField(processIndex.hasPrivateMemory, bucket.privateMemory)
  })

  return {
    main: usage(main),
    renderer: usage(renderer),
    other: usage(other),
    ...usage({
      cpu: main.cpu + renderer.cpu + other.cpu,
      memory: main.memory + renderer.memory + other.memory,
      privateMemory: main.privateMemory + renderer.privateMemory + other.privateMemory
    })
  }
}

type RowTotals = { cpu: number; memory: number; privateMemory: number }

function sumRows(rows: readonly ProcRow[]): RowTotals {
  const totals = { cpu: 0, memory: 0, privateMemory: 0 }
  for (const row of rows) {
    totals.cpu += row.cpu
    totals.memory += row.memory
    totals.privateMemory += clampMemoryMetric(row.privateMemory)
  }
  return totals
}

function usageOf(totals: RowTotals, hasPrivateMemory: boolean): UsageValues {
  return {
    cpu: clampMemoryMetric(totals.cpu),
    memory: clampMemoryMetric(totals.memory),
    ...optionalCommitField(hasPrivateMemory, totals.privateMemory)
  }
}

function addUsage(target: RowTotals, usage: UsageValues): void {
  target.cpu += usage.cpu
  target.memory += usage.memory
  target.privateMemory += clampMemoryMetric(usage.privateMemory)
}

async function runSnapshot(store: MemorySnapshotStore): Promise<MemorySnapshot> {
  const projectGroupName = createProjectGroupNameLookup(store)
  const repoName = createRepoNameLookup(store)
  const agentMark = agentRegistrationMark()
  const [processIndex, host] = await Promise.all([enumerateHostProcesses(), collectHostMemory()])
  const { hasPrivateMemory } = processIndex
  const appBuckets = bucketElectronMetrics(processIndex)
  const claimed = new Set<number>()
  const ptyTrees = claimPtyProcessTrees(processIndex, listRegisteredPtys(), claimed)
  const agentTrees = listAgentProcessRoots(agentMark).map((root) => ({
    ...root,
    rows: claimProcessTree(processIndex, root.pid, claimed)
  }))

  const orphan = createEmptyWorktreeMemoryBucket(
    ORPHAN_WORKTREE_ID,
    'Unattributed terminals',
    ORPHAN_WORKTREE_ID,
    'Other'
  )
  const worktreeBuckets = new Map<string, WorktreeMemoryBucket>()
  const bucketFor = (worktreeId: string): WorktreeMemoryBucket => {
    const existing = worktreeBuckets.get(worktreeId)
    if (existing) {
      return existing
    }
    const names = resolveWorktreeMemoryNames(worktreeId, store, projectGroupName, repoName)
    const bucket = createEmptyWorktreeMemoryBucket(
      worktreeId,
      names.worktreeName,
      names.repoId,
      names.repoName
    )
    worktreeBuckets.set(worktreeId, bucket)
    return bucket
  }

  const terminals: RowTotals = { cpu: 0, memory: 0, privateMemory: 0 }
  const restoredSessionIds = new Set<string>()
  for (const { pty, rows } of ptyTrees) {
    // This machine's panel names a restored terminal by its pane before the pane mounts; paired replies don't carry it.
    const restoredPaneKey = pty.paneKey ? null : (pty.restoredPaneKey ?? null)
    const session: SessionMemory = {
      sessionId: pty.sessionId ?? pty.ptyId,
      paneKey: pty.paneKey ?? restoredPaneKey,
      pid: pty.pid ?? 0,
      ...usageOf(sumRows(rows), hasPrivateMemory)
    }
    if (restoredPaneKey) {
      restoredSessionIds.add(session.sessionId)
    }
    const bucket = pty.worktreeId ? bucketFor(pty.worktreeId) : orphan
    addUsage(bucket, session)
    addUsage(terminals, session)
    bucket.sessions.push(session)
  }

  const agents: RowTotals = { cpu: 0, memory: 0, privateMemory: 0 }
  // Terminal-only usage of workspaces that also have chats, as paired clients have always seen it.
  const terminalUsage = new Map<string, RowTotals>()
  let hasChatOnlyRows = false
  for (const { agentSessionId, rows } of agentTrees) {
    const usage = usageOf(sumRows(rows), hasPrivateMemory)
    addUsage(agents, usage)
    const chat = agentSessionId === null ? null : readAgentProcessChat(agentSessionId)
    if (agentSessionId !== null && chat) {
      const bucket = bucketFor(chat.worktreeId)
      if (bucket.sessions.length === 0) {
        hasChatOnlyRows = true
      } else if (!terminalUsage.has(bucket.worktreeId)) {
        const { cpu, memory, privateMemory } = bucket
        terminalUsage.set(bucket.worktreeId, { cpu, memory, privateMemory })
      }
      addUsage(bucket, usage)
      const { cpu, memory } = usage
      ;(bucket.chats ??= []).push({
        agentSessionId,
        agent: chat.agent,
        name: chat.name,
        cpu,
        memory
      })
    }
  }

  const bucketList: WorktreeMemoryBucket[] = [...worktreeBuckets.values()]
  if (orphan.sessions.length > 0) {
    bucketList.push(orphan)
  }

  // Write before reading history to include this sample and refresh active-worktree retention.
  const now = Date.now()
  pushAppMemoryHistory(appBuckets.memory, now)
  const terminalSeries = recordWorkspaceMemorySeries(bucketList, terminalUsage, now)

  const worktrees: WorktreeMemory[] = bucketList.map(({ privateMemory, ...b }) => ({
    ...b,
    ...optionalCommitField(hasPrivateMemory, privateMemory),
    history: readMemoryHistory(b.worktreeId)
  }))
  const agentProcesses = usageOf(agents, hasPrivateMemory)

  const snapshot: MemorySnapshot = {
    app: { ...appBuckets, history: readAppMemoryHistory() },
    worktrees,
    agentProcesses,
    host,
    processMemoryMetric: processIndex.memoryMetric,
    ...snapshotCommitFields(
      hasPrivateMemory,
      clampMemoryMetric(appBuckets.privateMemory) + agents.privateMemory + terminals.privateMemory
    ),
    totalCpu: appBuckets.cpu + agentProcesses.cpu + terminals.cpu,
    totalMemory: appBuckets.memory + agentProcesses.memory + terminals.memory,
    collectedAt: now
  }
  recordPairedReplyParts(snapshot, {
    rowsDiffer: hasChatOnlyRows || terminalSeries.length > 0 || restoredSessionIds.size > 0,
    terminalSeries,
    hasPrivateMemory,
    readTerminalHistory: (worktreeId) => readMemoryHistory(terminalOnlyHistoryKey(worktreeId)),
    restoredSessionIds,
    totals: {
      ...snapshotCommitFields(
        hasPrivateMemory,
        clampMemoryMetric(appBuckets.privateMemory) + terminals.privateMemory
      ),
      totalCpu: appBuckets.cpu + terminals.cpu,
      totalMemory: appBuckets.memory + terminals.memory
    }
  })
  return snapshot
}
