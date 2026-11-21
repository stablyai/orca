import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { mailWakeObligation } from './mail-wake-obligation'

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
  /** Obligated panes per host, with the record each was indexed under. */
  private readonly hosts = new Map<string, Map<string, SleepingAgentSessionRecord>>()
  private readonly inputs = new Map<string, Readonly<Record<string, SleepingAgentSessionRecord>>>()

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
      this.records.set(pane, record)
      if (!before || !sameWake(before, record)) {
        maintained.add(pane)
      }
    }
    for (const pane of previous.keys()) {
      if (!next.has(pane)) {
        this.records.delete(pane)
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
