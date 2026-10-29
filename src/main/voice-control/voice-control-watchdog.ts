import type { VoiceRosterEntry } from './voice-control-roster'

/**
 * The coordinator's self check-in. "I'll let you know when it's done or if it needs you"
 * is only true if something deterministic watches: a generative model cannot be trusted
 * to spontaneously re-check, and an audio turn every minute to hear "nothing yet" is
 * noise. So the watchdog runs locally, computes findings from the roster projection, and
 * wakes the model only when there is something worth saying — the model is the voice of
 * the finding, never its author.
 *
 * v1 announces real state transitions only: an agent that finished, and an agent that is
 * waiting or blocked (which is what actually strands work — it needs the user). A
 * "working but silent for N minutes" heuristic is deliberately absent: a long test run
 * looks identical to a hang.
 */

export type OutstandingWorkItem = {
  paneKey: string
  spokenName: string
  task: string
  dispatchedAt: number
}

export type WatchdogFinding = {
  paneKey: string
  spokenName: string
  kind: 'done' | 'needs-user'
  /** Model-facing summary; relayed first-person, never read raw. */
  detail: string
}

const NEEDS_USER_STATES = new Set(['waiting', 'blocked'])

/**
 * A state that began before the dispatch is last task's news, not this one's — live: a
 * worker that never woke kept its previous session's 'done', and the watchdog announced
 * the new task as finished 20s after dispatch. The grace covers cross-host clock skew on
 * the state timestamp; beyond it, silence beats a false completion.
 */
const STALE_STATE_GRACE_MS = 90_000

export function computeWatchdogFindings(options: {
  outstanding: readonly OutstandingWorkItem[]
  roster: readonly VoiceRosterEntry[]
  /** Findings already announced this session, keyed `${paneKey}:${kind}`. */
  notified: ReadonlySet<string>
}): WatchdogFinding[] {
  const findings: WatchdogFinding[] = []
  for (const item of options.outstanding) {
    const entry = options.roster.find((candidate) => candidate.paneKey === item.paneKey)
    if (!entry) {
      continue
    }
    if ((entry.stateStartedAt ?? 0) + STALE_STATE_GRACE_MS < item.dispatchedAt) {
      continue
    }
    const kind =
      entry.state === 'done' ? 'done' : NEEDS_USER_STATES.has(entry.state) ? 'needs-user' : null
    if (!kind || options.notified.has(`${item.paneKey}:${kind}`)) {
      continue
    }
    findings.push({
      paneKey: item.paneKey,
      spokenName: item.spokenName,
      kind,
      detail:
        kind === 'done'
          ? `${item.spokenName} reports done${item.task ? ` (task: ${item.task})` : ''}.`
          : `${item.spokenName} is ${entry.state} — it needs the user's input${item.task ? ` (task: ${item.task})` : ''}.`
    })
  }
  return findings
}

export function watchdogFindingKey(finding: WatchdogFinding): string {
  return `${finding.paneKey}:${finding.kind}`
}
