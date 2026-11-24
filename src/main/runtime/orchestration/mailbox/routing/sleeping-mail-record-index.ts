import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { mailWakeObligation } from './mail-wake-obligation'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

function sameEnv(a: Record<string, string> | undefined, b: Record<string, string> | undefined) {
  const left = a ?? {}
  const right = b ?? {}
  let count = 0
  for (const key in left) {
    if (left[key] !== right[key]) {
      return false
    }
    count++
  }
  for (const _key in right) {
    count--
  }
  return count === 0
}

/** Whether two records name the same wake: same owner, obligation and resume launch. */
function sameWake(a: SleepingAgentSessionRecord, b: SleepingAgentSessionRecord): boolean {
  const pa = a.providerSession
  const pb = b.providerSession
  const la = a.launchConfig
  const lb = b.launchConfig
  return (
    a === b ||
    (a.paneKey === b.paneKey &&
      a.worktreeId === b.worktreeId &&
      (a.connectionId ?? null) === (b.connectionId ?? null) &&
      a.agent === b.agent &&
      a.capturedAt === b.capturedAt &&
      a.tabId === b.tabId &&
      a.state === b.state &&
      a.origin === b.origin &&
      (a.restoreOnTabOpenOnly === true) === (b.restoreOnTabOpenOnly === true) &&
      mailWakeObligation(a) === mailWakeObligation(b) &&
      pa.key === pb.key &&
      pa.id === pb.id &&
      pa.transcriptPath === pb.transcriptPath &&
      pa.cwd === pb.cwd &&
      pa.effort === pb.effort &&
      pa.permissionMode === pb.permissionMode &&
      la?.agentCommand === lb?.agentCommand &&
      la?.agentArgs === lb?.agentArgs &&
      la?.ompResumeFilePath === lb?.ompResumeFilePath &&
      sameEnv(la?.agentEnv, lb?.agentEnv))
  )
}

export class SleepingMailRecordIndex {
  readonly records = new Map<string, SleepingAgentSessionRecord>()
  /** A pane moved to another tab keeps its leaf id, so a Run or Dispatch's older key still finds it. */
  private readonly panesByLeaf = new Map<string, string>()
  /** The pane whose saved record names each handle, so a slept agent's name finds its pane by key. */
  private readonly panesByHandle = new Map<string, string>()
  /** Obligated panes per host, with the record each was indexed under. */
  private readonly hosts = new Map<string, Map<string, SleepingAgentSessionRecord>>()
  private readonly hostByPane = new Map<string, string>()
  private readonly panesByWorktree = new Map<string, Set<string>>()
  private readonly inputs = new Map<string, Readonly<Record<string, SleepingAgentSessionRecord>>>()
  /** Panes whose sleep reached main after its first read: mail sent while they went to sleep found
   *  no record, so their first re-check also reads the Runs and Dispatches they own. */
  private readonly arrivals = new Set<string>()
  /** Set once the watch's first read of every host is done: a record seen after it arrived then,
   *  whether its host was cached, new, or forgotten after a removal and back. */
  private initialReadDone = false

  finishInitialRead(): void {
    this.initialReadDone = true
  }

  takeArrival(pane: string): boolean {
    return this.arrivals.delete(pane)
  }

  /** The sleeping pane a recorded owner key names now: itself, or the pane its leaf moved to. */
  currentPane(paneKey: string): string {
    const leafId = this.records.has(paneKey) ? undefined : parsePaneKey(paneKey)?.leafId
    return (leafId && this.panesByLeaf.get(leafId)) || paneKey
  }

  /** The panes whose sleep record is in this workspace. */
  panesIn(worktreeId: string): Iterable<string> {
    return this.panesByWorktree.get(worktreeId) ?? []
  }

  /** The host whose session holds the pane's sleep record. */
  hostOf(paneKey: string): string | null {
    return this.hostByPane.get(paneKey) ?? this.hostByPane.get(this.currentPane(paneKey)) ?? null
  }

  paneForHandle(handle: string): string | null {
    return this.panesByHandle.get(handle) ?? null
  }

  private indexHandle(handle: string | undefined, pane: string, present: boolean): void {
    if (!handle) {
      return
    }
    if (present) {
      this.panesByHandle.set(handle, pane)
    } else if (this.panesByHandle.get(handle) === pane) {
      this.panesByHandle.delete(handle)
    }
  }

  private indexWorktree(worktreeId: string | undefined, pane: string, present: boolean): void {
    if (!worktreeId) {
      return
    }
    const panes = this.panesByWorktree.get(worktreeId)
    if (present) {
      this.panesByWorktree.set(worktreeId, (panes ?? new Set()).add(pane))
    } else if (panes?.delete(pane) && panes.size === 0) {
      this.panesByWorktree.delete(worktreeId)
    }
  }

  private indexLeaf(pane: string, present: boolean): void {
    const leafId = parsePaneKey(pane)?.leafId
    if (!leafId) {
      return
    }
    if (present) {
      this.panesByLeaf.set(leafId, pane)
    } else if (this.panesByLeaf.get(leafId) === pane) {
      this.panesByLeaf.delete(leafId)
    }
  }

  /** A host no longer live: a refresh with none already dropped its records; its cached input goes too. */
  forgetUnlessLive(host: string, live: readonly string[]): void {
    if (!live.includes(host) && !this.hosts.has(host)) {
      this.inputs.delete(host)
    }
  }

  affectedHosts(host: string | null, current: readonly string[]): Iterable<string> {
    return host === null ? new Set([...current, ...this.hosts.keys()]) : [host]
  }

  /** Re-indexes one host's records; returns the panes whose wake identity changed. A session write
   *  already copies every record, so this pass reads a few fields per record and builds nothing. */
  refresh(
    host: string,
    records: Readonly<Record<string, SleepingAgentSessionRecord>>,
    changed: (pane: string) => void
  ): Set<string> {
    // Session writes that left this host's records untouched keep the same map.
    if (this.inputs.get(host) === records) {
      return new Set()
    }
    const seenHost = this.initialReadDone || this.inputs.has(host)
    this.inputs.set(host, records)
    const previous = this.hosts.get(host) ?? new Map<string, SleepingAgentSessionRecord>()
    const next = new Map<string, SleepingAgentSessionRecord>()
    const maintained = new Set<string>()
    for (const key in records) {
      const record = records[key]
      if (!record || !mailWakeObligation(record)) {
        continue
      }
      const pane = record.paneKey
      const before = previous.get(pane)
      next.set(pane, record)
      if (before && before.worktreeId !== record.worktreeId) {
        this.indexWorktree(before.worktreeId, pane, false)
      }
      this.records.set(pane, record)
      this.hostByPane.set(pane, host)
      this.indexWorktree(record.worktreeId, pane, true)
      this.indexLeaf(pane, true)
      if (before?.terminalHandle !== record.terminalHandle) {
        this.indexHandle(before?.terminalHandle, pane, false)
      }
      this.indexHandle(record.terminalHandle, pane, true)
      if (!before || !sameWake(before, record)) {
        maintained.add(pane)
      }
      if (!before && seenHost) {
        this.arrivals.add(pane)
      }
    }
    for (const pane of previous.keys()) {
      if (!next.has(pane)) {
        this.records.delete(pane)
        this.arrivals.delete(pane)
        this.hostByPane.delete(pane)
        this.indexWorktree(previous.get(pane)?.worktreeId, pane, false)
        this.indexLeaf(pane, false)
        this.indexHandle(previous.get(pane)?.terminalHandle, pane, false)
        maintained.add(pane)
      }
    }
    for (const pane of maintained) {
      changed(pane)
    }
    if (next.size) {
      this.hosts.set(host, next)
    } else {
      this.hosts.delete(host)
    }
    return maintained
  }
}
