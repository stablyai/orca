import { isFinalAutomationRunStatus, type AutomationRun } from '../../shared/automations-types'
import { AUTOMATION_RUN_REPORT_GRACE_MS } from '../../shared/automation-run-results'
import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import { InvalidArgumentError } from '../runtime/rpc/core'
import { isEquivalentPaneKey } from '../runtime/orchestration/db/pane-key-match'

export const NOT_IN_AUTOMATION_RUN_MESSAGE =
  'Not running inside an Orca automation run on this host. Run this command from the automation agent.'

export const REMOTE_TERMINAL_UNSUPPORTED_MESSAGE =
  'Reporting automation results from WSL or SSH terminals is not supported yet.'

/** The caller's session as this host proved it: a live chat record, or a terminal pane whose PTY it hosts. */
export type AutomationRunCallerSession =
  | { kind: 'chat'; sessionIds: readonly string[] }
  | { kind: 'terminal'; paneKey: string; ptyId: string }

export type AutomationRunCallerTerminalReader = {
  getTerminalHandleForPaneKey(paneKey: string): string | null
  getTerminalPtyIdForHandle(handle: string): string | null
}

/** Terminal identity is a same-user claim checked like orchestration's pane fence: handle, pane and PTY must agree. */
export function terminalCallerSession(
  runtime: AutomationRunCallerTerminalReader,
  evidence: OrchestrationCompatibilityEvidence | undefined
): AutomationRunCallerSession | null {
  const handle = evidence?.terminalHandle
  const paneKey = evidence?.paneKey
  if (!handle || !paneKey || evidence.host) {
    return null
  }
  let liveHandle: string | null
  let ptyId: string | null
  try {
    liveHandle = runtime.getTerminalHandleForPaneKey(paneKey)
    ptyId = liveHandle === handle ? runtime.getTerminalPtyIdForHandle(handle) : null
  } catch {
    return null
  }
  return ptyId ? { kind: 'terminal', paneKey, ptyId } : null
}

function runBelongsToSession(run: AutomationRun, session: AutomationRunCallerSession): boolean {
  if (session.kind === 'chat') {
    return (
      run.sessionKind === 'chat' &&
      !!run.chatSessionId &&
      session.sessionIds.includes(run.chatSessionId)
    )
  }
  return (
    run.sessionKind === 'terminal' &&
    !!run.terminalPaneKey &&
    isEquivalentPaneKey(run.terminalPaneKey, session.paneKey) &&
    run.terminalPtyId === session.ptyId
  )
}

function acceptsReports(run: AutomationRun, now: number): boolean {
  if (!isFinalAutomationRunStatus(run.status)) {
    return run.status === 'dispatched' || run.status === 'dispatching'
  }
  return run.finishedAt !== undefined && now - run.finishedAt <= AUTOMATION_RUN_REPORT_GRACE_MS
}

/** A reused session carries every earlier run's prompt; reports go to the newest run it is serving. */
export function resolveCallerAutomationRun(
  runs: readonly AutomationRun[],
  session: AutomationRunCallerSession,
  now: number
): AutomationRun {
  const run = runs
    .filter((entry) => runBelongsToSession(entry, session))
    .toSorted(
      (left, right) =>
        (right.dispatchedAt ?? right.createdAt) - (left.dispatchedAt ?? left.createdAt)
    )[0]
  if (!run || !acceptsReports(run, now)) {
    throw new InvalidArgumentError(NOT_IN_AUTOMATION_RUN_MESSAGE)
  }
  return run
}
