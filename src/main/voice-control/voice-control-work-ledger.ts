import type { VoiceRosterEntry } from './voice-control-roster'
import {
  computeWatchdogFindings,
  watchdogFindingKey,
  type OutstandingWorkItem,
  type WatchdogFinding
} from './voice-control-watchdog'

/**
 * The watchdog ledger: work the coordinator kicked off and owes follow-through on, keyed
 * by pane, plus the findings already announced. A pane's entry is settled by a completion
 * reply (progress mail — status, question, escalation — must not settle it: a stop after
 * a progress update would open no dormant watcher for the completion still to come) or
 * by a 'done' finding. A fresh dispatch re-arms the pane's notices so the new task's
 * completion is announced even when the previous task's was.
 */
export class VoiceControlWorkLedger {
  private readonly outstanding = new Map<string, OutstandingWorkItem>()
  /** Findings already announced, `${paneKey}:${kind}` — each fires once per dispatch. */
  private readonly notifiedFindings = new Set<string>()

  /** The ledger write — one shape, used by message_agent and the launch ceremony. */
  record(paneKey: string, spokenName: string, task: string): void {
    // A fresh task re-arms the pane's notices: without the reset the new dispatch inherits
    // the previous task's announced keys and its own completion is never spoken.
    for (const key of this.notifiedFindings) {
      if (key.startsWith(`${paneKey}:`)) {
        this.notifiedFindings.delete(key)
      }
    }
    this.outstanding.set(paneKey, { paneKey, spokenName, task, dispatchedAt: Date.now() })
  }

  /** A completion report settles the pane's follow-through. */
  settle(paneKey: string): void {
    this.outstanding.delete(paneKey)
  }

  hasOutstanding(): boolean {
    return this.outstanding.size > 0
  }

  /** Seeds the dormant watcher's drain set when the session ends. */
  outstandingPanes(): string[] {
    return [...this.outstanding.keys()]
  }

  /** New findings from the roster projection; recording them marks them announced. */
  tick(roster: readonly VoiceRosterEntry[]): WatchdogFinding[] {
    const findings = computeWatchdogFindings({
      outstanding: [...this.outstanding.values()],
      roster,
      notified: this.notifiedFindings
    })
    for (const finding of findings) {
      this.notifiedFindings.add(watchdogFindingKey(finding))
      if (finding.kind === 'done') {
        this.outstanding.delete(finding.paneKey)
      }
    }
    return findings
  }
}
