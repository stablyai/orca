import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { mailWakeObligation } from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'

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
    record.mailWake?.capturedAt ?? record.capturedAt,
    obligation
  ])
}

function invocation(record: SleepingAgentSessionRecord | undefined): string | null {
  if (!record || !mailWakeObligation(record)) {
    return null
  }
  const provider = record.providerSession
  const launch = record.launchConfig
  const marker = record.mailWake
  const attempt = marker?.attempt
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
    Object.entries(launch?.agentEnv ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    marker?.id,
    marker?.startedAt,
    attempt?.ptyId,
    attempt?.incarnationId,
    attempt?.launchToken,
    attempt?.startedAt
  ])
}

export class SleepingMailRecordIndex {
  readonly records = new Map<string, SleepingAgentSessionRecord>()
  readonly custody = new Map<string, SleepingAgentSessionRecord>()
  readonly changed = new Set<string>()
  private readonly hosts = new Map<string, Map<string, SleepingAgentSessionRecord>>()

  affectedHosts(host: string | null, current: readonly string[]): Iterable<string> {
    return host === null ? new Set([...current, ...this.hosts.keys()]) : [host]
  }

  launchTokens(): ReadonlySet<string> {
    return new Set(
      [...this.custody.values()].flatMap((record) =>
        record.mailWake?.attempt ? [record.mailWake.attempt.launchToken] : []
      )
    )
  }

  refresh(
    host: string,
    records: Readonly<Record<string, SleepingAgentSessionRecord>>,
    changed: (pane: string) => void
  ): Set<string> {
    const previous = this.hosts.get(host) ?? new Map<string, SleepingAgentSessionRecord>()
    const next = new Map(Object.values(records).map((record) => [record.paneKey, record]))
    const maintained = new Set<string>()
    for (const [pane, before] of previous) {
      if (!next.has(pane)) {
        this.records.delete(pane)
        this.custody.delete(pane)
        if (mailWakeObligation(before)) {
          this.changed.add(pane)
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
      if (record.mailWake) {
        this.custody.set(pane, record)
      } else {
        this.custody.delete(pane)
      }
      if (before === record) {
        continue
      }
      const ownershipChanged = ownership(before) !== ownership(record)
      if (ownershipChanged) {
        this.changed.add(pane)
      }
      if (ownershipChanged || invocation(before) !== invocation(record)) {
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
