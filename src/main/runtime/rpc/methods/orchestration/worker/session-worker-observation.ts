import type { AgentStatusState } from '../../../../../../shared/agent-status-types'
import { structuredAgentSessionAgentStatus } from '../../../../../../shared/structured-agent-session-agent-status'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { chatAssigneeSessionId, observeChatAssignee } from '../../../../orchestration/chat-assignee'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  holdStructuredWorker,
  observeStructuredSession,
  resolveStructuredWorkerIdentity
} from '../../../../structured-worker-authority'

export type SessionWorkerObservation = {
  terminal: null
  exact: boolean
  status: 'identity_changed' | 'live' | 'exited' | 'unverifiable'
  reason?: string
  addressable?: boolean
  terminalHandle: null
  /** The session running the worker, when observed live; the fleet reads its published status. */
  liveSessionId?: string
}

/** Read session records for structured/chat workers; null selects the PTY path. */
export async function inspectSessionWorker(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  db: OrchestrationDb,
  dispatchId: string,
  terminalHandle: string
): Promise<SessionWorkerObservation | null> {
  // Chat address is its exact identity; ensure host records are installed after restart.
  if (chatAssigneeSessionId(terminalHandle)) {
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
  return observeSessionWorker(db, dispatchId, terminalHandle)
}

/** The session-record verdict worker-show serves, for callers that installed the host already. */
export function observeSessionWorker(
  db: OrchestrationDb,
  dispatchId: string,
  terminalHandle: string
): SessionWorkerObservation | null {
  const chat = chatAssigneeSessionId(terminalHandle)
  if (chat) {
    const observed = observeChatAssignee(chat, db)
    return {
      terminal: null,
      exact: true,
      status: observed.status,
      ...(observed.status === 'unverifiable' ? { reason: observed.reason } : {}),
      ...(observed.status === 'live' ? { liveSessionId: observed.session.sessionId } : {}),
      terminalHandle: null
    }
  }
  const structured = resolveStructuredWorkerIdentity(terminalHandle, db)
  if (!structured) {
    return null
  }
  // Structured registry proves pane/lineage identity without a PTY.
  // Omit agentWait: terminal scans cannot see journal questions, and null falsely claims no wait.
  const exact = db.isDispatchProcessCurrent({
    dispatchId,
    paneKey: structured.paneKey,
    processIncarnation: structured.processIncarnation
  })
  // One lineage walk, so status and `addressable` judge the same session even mid-`/clear`.
  const hold = holdStructuredWorker(structured, db)
  const observation =
    hold.kind === 'unverifiable'
      ? { status: 'unverifiable' as const, reason: hold.reason }
      : observeStructuredSession(hold.running.sessionId)
  const addressable = hold.kind === 'unverifiable' ? null : hold.kind === 'held'
  return {
    terminal: null,
    exact,
    status: exact ? observation.status : 'identity_changed',
    ...(exact && observation.reason ? { reason: observation.reason } : {}),
    ...(exact && addressable !== null ? { addressable } : {}),
    ...(exact && observation.status === 'live' && hold.kind !== 'unverifiable'
      ? { liveSessionId: hold.running.sessionId }
      : {}),
    terminalHandle: null
  }
}

/** What the fleet reads off a session worker: worker-show's verdict and the host's published status. */
export type FleetSessionObservation = {
  status: 'live' | 'exited' | 'unverifiable'
  /** Null until the host has published the running session's status. */
  published: {
    provider: { id: string; model: string | null }
    activity: AgentStatusState | null
  } | null
}

export type FleetSessionObserver = (
  dispatchId: string,
  terminalHandle: string
) => FleetSessionObservation | null

/** Fleet verdicts for session workers, for callers that installed the host already. */
export function fleetSessionObserver(db: OrchestrationDb): FleetSessionObserver {
  return (dispatchId, terminalHandle) => {
    const observed = observeSessionWorker(db, dispatchId, terminalHandle)
    if (!observed) {
      return null
    }
    const summary = observed.liveSessionId
      ? getStructuredAgentSessionHost()?.readStatusSummary(observed.liveSessionId)
      : undefined
    return {
      // A replaced identity is not this worker's verdict; it proves neither life nor exit.
      status: observed.status === 'identity_changed' ? 'unverifiable' : observed.status,
      published: summary
        ? {
            provider: { id: summary.agent, model: summary.model ?? null },
            activity: summary.status
              ? structuredAgentSessionAgentStatus({ ...summary, status: summary.status }).state
              : null
          }
        : null
    }
  }
}

/** A fleet page's session-worker verdicts, read off the session records a restart leaves uninstalled. */
export async function sessionWorkerFleetObserver(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  db: OrchestrationDb,
  rows: readonly { agentTerminalHandle: string | null }[]
): Promise<FleetSessionObserver> {
  if (rows.some((row) => chatAssigneeSessionId(row.agentTerminalHandle))) {
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
  return fleetSessionObserver(db)
}
