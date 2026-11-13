import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  mailWakeEligibility,
  mailWakeObligation
} from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'

export class SleepingMailRecordIndex {
  readonly records = new Map<string, SleepingAgentSessionRecord>()
  readonly custody = new Map<string, SleepingAgentSessionRecord>()
  readonly changed = new Set<string>()
  private readonly hostPanes = new Map<string, Set<string>>()

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
  ): boolean {
    const previous = this.hostPanes.get(host) ?? new Set<string>()
    const next = new Set(Object.keys(records))
    let eligibilityChanged = false
    for (const pane of previous) {
      if (!next.has(pane)) {
        eligibilityChanged ||= this.records.has(pane)
        this.records.delete(pane)
        this.custody.delete(pane)
        this.changed.add(pane)
        changed(pane)
      }
    }
    for (const record of Object.values(records)) {
      const before = this.records.get(record.paneKey)
      if (before !== record) {
        this.changed.add(record.paneKey)
      }
      eligibilityChanged ||=
        mailWakeEligibility(before ? [before] : []) !== mailWakeEligibility([record])
      if (mailWakeObligation(record)) {
        this.records.set(record.paneKey, record)
      } else {
        this.records.delete(record.paneKey)
      }
      if (record.mailWake) {
        this.custody.set(record.paneKey, record)
      } else {
        this.custody.delete(record.paneKey)
      }
      changed(record.paneKey)
    }
    this.hostPanes.set(host, next)
    return eligibilityChanged
  }
}
