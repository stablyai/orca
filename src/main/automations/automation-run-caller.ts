import { isFinalAutomationRunStatus, type AutomationRun } from '../../shared/automations-types'
import { AUTOMATION_RUN_REPORT_GRACE_MS } from '../../shared/automation-run-results'
import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import { InvalidArgumentError } from '../runtime/rpc/core'
import { isEquivalentPaneKey } from '../runtime/orchestration/db/pane-key-match'
import { automationRunRecency } from '../../shared/automation-session-reuse'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { readAutomationRunReceipt } from './automation-run-receipt'

export const NOT_IN_AUTOMATION_RUN_MESSAGE =
  'Not running inside an Orca automation run on this host. Run this command from the automation agent.'

export const REMOTE_TERMINAL_UNSUPPORTED_MESSAGE =
  'Reporting automation results from WSL or SSH terminals is not supported yet.'

/** The caller's session as this host proved it: a live chat record, or a terminal pane whose PTY it hosts. */
export type AutomationRunCallerSession =
  | {
      kind: 'chat'
      sessionIds: readonly string[]
      submissions: readonly AgentJournalSubmission[]
      store: Pick<AgentSessionRecordStore, 'getOperationRow' | 'getConversation'>
    }
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

/** Queue cards cannot report; human turns retain the last submitted automation's attribution. */
export function resolveCallerAutomationRun(
  runs: readonly AutomationRun[],
  session: AutomationRunCallerSession,
  now: number
): AutomationRun {
  const bound = runs.filter((entry) => runBelongsToSession(entry, session))
  const run =
    session.kind === 'chat'
      ? submittedChatRun(bound, session)
      : bound.toSorted((left, right) => automationRunRecency(right) - automationRunRecency(left))[0]
  if (!run || !acceptsReports(run, now)) {
    throw new InvalidArgumentError(NOT_IN_AUTOMATION_RUN_MESSAGE)
  }
  return run
}

function submittedChatRun(
  runs: readonly AutomationRun[],
  session: Extract<AutomationRunCallerSession, { kind: 'chat' }>
): AutomationRun | undefined {
  const byMessage = new Map<string, AutomationRun>()
  for (const run of runs) {
    const receipt = readAutomationRunReceipt(session.store, run)
    if (
      receipt?.kind === 'chat' &&
      receipt.accepted &&
      receipt.sessionId === run.chatSessionId &&
      receipt.messageId
    ) {
      byMessage.set(receipt.messageId, run)
    }
  }
  const submissions = session.submissions.toSorted(
    (left, right) =>
      (right.submittedSequence ?? 0) - (left.submittedSequence ?? 0) ||
      right.submittedAt - left.submittedAt
  )
  for (const submission of submissions) {
    if (submission.dispatchState === 'rejected') {
      continue
    }
    const run = byMessage.get(submission.queuedMessageId ?? submission.clientMessageId)
    if (run) {
      return run
    }
  }
  return undefined
}
