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

export class SleepingMailRecordIndex {
  readonly records = new Map<string, SleepingAgentSessionRecord>()
  private readonly hosts = new Map<string, Map<string, SleepingAgentSessionRecord>>()
  private readonly inputs = new Map<string, Readonly<Record<string, SleepingAgentSessionRecord>>>()

  affectedHosts(host: string | null, current: readonly string[]): Iterable<string> {
    return host === null ? new Set([...current, ...this.hosts.keys()]) : [host]
  }

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
    const next = new Map(Object.values(records).map((record) => [record.paneKey, record]))
    const maintained = new Set<string>()
    for (const [pane, before] of previous) {
      if (!next.has(pane)) {
        this.records.delete(pane)
        if (mailWakeObligation(before)) {
          maintained.add(pane)
          changed(pane)
        }
      }
    }
    for (const [pane, record] of next) {
      const before = previous.get(pane)
      if (mailWakeObligation(record)) {
        this.records.set(pane, record)
      } else {
        this.records.delete(pane)
      }
      if (before === record) {
        continue
      }
      if (ownership(before) !== ownership(record) || invocation(before) !== invocation(record)) {
        maintained.add(pane)
        changed(pane)
      }
    }
    if (next.size) {
      this.hosts.set(host, next)
    } else {
      this.hosts.delete(host)
    }
    return maintained
  }
}
