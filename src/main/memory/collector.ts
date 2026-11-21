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
import {
  createEmptyWorktreeMemoryBucket,
  pushAppMemoryHistory,
  pushMemoryHistorySample,
  readAppMemoryHistory,
  readMemoryHistory,
  hasMemoryHistory,
  seedMemoryHistory,
  terminalOnlyHistoryKey,
  createProjectGroupNameLookup,
  createRepoNameLookup,
  resolveWorktreeMemoryNames,
  sweepStaleMemoryHistory,
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

let inflight: { chats: boolean; promise: Promise<MemorySnapshot> } | null = null

/** `chats: false` skips chat attribution for callers that receive terminals only. */
export async function collectMemorySnapshot(
  store: MemorySnapshotStore,
  { chats = true }: { chats?: boolean } = {}
): Promise<MemorySnapshot> {
  // Runtime callers share one process-wide store, so coalesced sweeps use the same data source.
  if (inflight && (inflight.chats || !chats)) {
    return inflight.promise
  }
  const sweep = {
    chats,
    promise: runSnapshot(store, chats)
      .catch((err) => {
        console.warn('[memory] snapshot failed; returning empty', err)
        return emptyMemorySnapshot()
      })
      .finally(() => {
        if (inflight === sweep) {
          inflight = null
        }
      })
  }
  inflight = sweep
  return sweep.promise
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

async function runSnapshot(
  store: MemorySnapshotStore,
  withChats: boolean
): Promise<MemorySnapshot> {
  const projectGroupName = createProjectGroupNameLookup(store)
  const repoName = createRepoNameLookup(store)
  const agentMark = agentRegistrationMark()
  const [processIndex, host] = await Promise.all([enumerateHostProcesses(), collectHostMemory()])
  const { hasPrivateMemory } = processIndex
  const appBuckets = bucketElectronMetrics(processIndex)
  const claimed = new Set<number>()
  const ptyTrees = claimPtyProcessTrees(processIndex, listRegisteredPtys(), claimed)
  const agentTrees = (withChats ? listAgentProcessRoots(agentMark) : []).map((root) => ({
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
    const session: SessionMemory = {
      sessionId: pty.sessionId ?? pty.ptyId,
      paneKey: pty.paneKey,
      pid: pty.pid ?? 0,
      ...usageOf(sumRows(rows), hasPrivateMemory)
    }
    if (pty.restored) {
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
  for (const { agentSessionId, rows } of agentTrees) {
    const usage = usageOf(sumRows(rows), hasPrivateMemory)
    addUsage(agents, usage)
    const chat = agentSessionId === null ? null : readAgentProcessChat(agentSessionId)
    if (agentSessionId !== null && chat) {
      const bucket = bucketFor(chat.worktreeId)
      if (bucket.sessions.length > 0 && !terminalUsage.has(bucket.worktreeId)) {
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
  // The plain series is what this machine shows (chats included). A workspace that has had chats also
  // keeps a terminal-only series, started from the plain one, for paired machines.
  const terminalSeries: { worktreeId: string; usage: RowTotals }[] = []
  for (const bucket of bucketList) {
    const terminalKey = terminalOnlyHistoryKey(bucket.worktreeId)
    const separate = hasMemoryHistory(terminalKey)
    if (bucket.sessions.length > 0 && (bucket.chats || separate)) {
      if (!separate) {
        seedMemoryHistory(terminalKey, bucket.worktreeId, now)
      }
      const usage = terminalUsage.get(bucket.worktreeId) ?? bucket
      pushMemoryHistorySample(terminalKey, usage.memory, now)
      terminalSeries.push({ worktreeId: bucket.worktreeId, usage })
    }
    // A sweep without chats can't extend the chat-inclusive series of a workspace that has chats.
    if (withChats || !separate) {
      pushMemoryHistorySample(bucket.worktreeId, bucket.memory, now)
    }
  }
  sweepStaleMemoryHistory(now)

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
    terminalRows: new Map(
      terminalSeries.map(({ worktreeId, usage }) => [
        worktreeId,
        {
          ...usageOf(usage, hasPrivateMemory),
          history: readMemoryHistory(terminalOnlyHistoryKey(worktreeId))
        }
      ])
    ),
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
