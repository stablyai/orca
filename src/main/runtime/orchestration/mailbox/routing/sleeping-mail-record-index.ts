import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { mailWakeObligation } from './mail-wake-obligation'

function ownership(record: SleepingAgentSessionRecord | undefined): string | null {
  const obligation = mailWakeObligation(record)
  if (!record || !obligation) {
    return null
  }
  return JSON.stringify([
    record.paneKey,
    record.worktreeId,
    record.connectionId ?? null,
    record.agent,
    record.providerSession.key,
    record.providerSession.id,
    record.agent === 'pi' || record.agent === 'prime-agent'
      ? record.providerSession.transcriptPath
      : null,
    record.capturedAt,
    obligation
  ])
}

function invocation(record: SleepingAgentSessionRecord | undefined): string | null {
  if (!record || !mailWakeObligation(record)) {
    return null
  }
  const provider = record.providerSession
  const launch = record.launchConfig
  return JSON.stringify([
    record.capturedAt,
    record.tabId,
    record.state,
    record.origin,
    record.restoreOnTabOpenOnly === true,
    provider.transcriptPath,
    provider.cwd,
    provider.effort,
    provider.permissionMode,
    launch?.agentCommand,
    launch?.agentArgs,
    launch?.ompResumeFilePath,
    Object.entries(launch?.agentEnv ?? {}).sort(([a], [b]) => a.localeCompare(b))
  ])
}

/** A sleeping record's wake identity; non-obligated records have none and are skipped cheaply. */
function fingerprint(record: SleepingAgentSessionRecord): string | null {
  const owner = ownership(record)
  return owner === null ? null : `${owner}${invocation(record)}`
}

export class SleepingMailRecordIndex {
  readonly records = new Map<string, SleepingAgentSessionRecord>()
  /** Obligated panes per host, with the fingerprint each was indexed under. */
  private readonly hosts = new Map<string, Map<string, string>>()
  private readonly inputs = new Map<string, Readonly<Record<string, SleepingAgentSessionRecord>>>()

  affectedHosts(host: string | null, current: readonly string[]): Iterable<string> {
    return host === null ? new Set([...current, ...this.hosts.keys()]) : [host]
  }

  /** Re-indexes one host's records; returns the panes whose wake identity changed. A session write
   *  already copies every record, so this pass is one cheap field check per non-sleeping record. */
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
    const previous = this.hosts.get(host) ?? new Map<string, string>()
    const next = new Map<string, string>()
    const maintained = new Set<string>()
    for (const key in records) {
      const record = records[key]
      if (!record || !mailWakeObligation(record)) {
        continue
      }
      const pane = record.paneKey
      const print = fingerprint(record)
      if (print === null) {
        continue
      }
      next.set(pane, print)
      this.records.set(pane, record)
      if (previous.get(pane) !== print) {
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
