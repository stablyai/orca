/** A helper agent's permission prompt inside a Claude terminal worker. Claude draws its dialog only
 *  once every PermissionRequest hook returns (probe 2026-11-19, 2.1.326), so while Orca holds it the
 *  worker's terminal shows nothing: Orca holds it only where someone in Orca can answer or see it, and
 *  sends its card at once, since no stop of the lead's names it. */
import type { AgentHookEventPayload } from '../../../../../shared/agent-hook-listener/listener-event'
import { claudeSubagentTranscriptPath } from '../../../../../shared/agent-hook-listener/providers/claude/transcripts/claude-subagent-transcript-path'
import type { WorkerApprovalPayload } from '../../../../../shared/orchestration/approvals/worker-approval-payload'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { DispatchContextRow } from '../../db/orchestration-records'
import { dispatchReportMailbox } from '../reports/dispatch-report-mailbox'
import { isDeliberateRest, sendWorkerReport } from '../turn-stops/worker-turn-stop-report'
import { approvalReportId } from '../turn-stops/worker-presence-report'
import {
  holdPayload,
  type TerminalWorkerApprovalHold,
  type TerminalWorkerApprovalHoldsDeps
} from './terminal-worker-approval-hold'

/** Where Claude records this prompt's call: a helper's only in its own transcript. */
export function promptTranscriptPath(event: AgentHookEventPayload): string | null | undefined {
  const session = event.providerSession?.transcriptPath
  return session && event.toolAgentId !== undefined
    ? claudeSubagentTranscriptPath(session, event.toolAgentId)
    : session
}

/** Holding hides a helper's dialog from the terminal, so only a coordinator that can answer or show it may. */
export function orcaMayHoldHelper(
  deps: Pick<TerminalWorkerApprovalHoldsDeps, 'coordinatorApprovals' | 'isChatMailbox'>,
  worker: { db: OrchestrationDb; dispatch: DispatchContextRow }
): boolean {
  return (
    deps.coordinatorApprovals?.() === true ||
    deps.isChatMailbox?.(dispatchReportMailbox(worker.db, worker.dispatch)) === true
  )
}

export function promptSummary(event: AgentHookEventPayload): WorkerApprovalPayload['summary'] {
  const { toolName, toolInput } = event.payload
  const helper =
    event.toolAgentId === undefined
      ? ''
      : ` · from the worker's ${event.toolAgentType ? `${event.toolAgentType} ` : ''}helper`
  return {
    title: `Allow ${toolName ?? 'this tool call'}?${helper}`,
    ...(toolName ? { tool: toolName } : {}),
    detail: toolInput ?? null,
    reason: null
  }
}

/** The helper prompt's own card; true once it is in the coordinator's mail. */
export function reportHelperPrompt(
  hold: TerminalWorkerApprovalHold,
  deps: TerminalWorkerApprovalHoldsDeps
): boolean {
  const target = { kind: 'local' as const, dispatch: hold.dispatch }
  // A worker waiting on mail is not stopped for a person: Claude shows the dialog in its terminal.
  if (isDeliberateRest(hold.db, target, { reason: 'needs-input' }, deps)) {
    hold.reported = false
    return false
  }
  // Not a rest of the worker's: its lead keeps working, so its presence is unchanged.
  hold.reported = sendWorkerReport(
    hold.db,
    target,
    {
      from: hold.handle,
      reason: 'needs-input',
      lastOutput: undefined,
      approval: holdPayload(hold)
    },
    approvalReportId(hold.dispatch.id, hold.approvalId),
    deps
  )
  return hold.reported
}

export function findHelperHold(
  holds: Iterable<TerminalWorkerApprovalHold>,
  paneKey: string,
  matches: (hold: TerminalWorkerApprovalHold) => boolean
): TerminalWorkerApprovalHold | undefined {
  for (const hold of holds) {
    if (hold.helper !== undefined && hold.paneKey === paneKey && matches(hold)) {
      return hold
    }
  }
  return undefined
}
