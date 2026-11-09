import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { isStructuredWorkerHandle } from '../../../../../../shared/orchestration/workers/structured-worker-handle'
import {
  chatAssigneeSessionId,
  observeChatAssignee
} from '../../../../orchestration/workers/lifecycle/chat-assignee'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import {
  holdStructuredWorker,
  observeStructuredSession
} from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import type { StructuredWorkerIdentity } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { resolveStructuredWorkerForDispatch } from '../structured-workers/orchestration-structured-worker-lifecycle'

export type SessionWorkerObservation = {
  terminal: null
  exact: boolean
  status: 'identity_changed' | 'live' | 'exited' | 'unverifiable'
  reason?: string
  addressable?: boolean
  terminalHandle: null
}

/** Read session records for structured/chat workers; null selects the PTY path. */
export async function inspectSessionWorker(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  db: OrchestrationDb,
  dispatchId: string,
  terminalHandle: string
): Promise<SessionWorkerObservation | null> {
  const chat = chatAssigneeSessionId(terminalHandle)
  if (chat) {
    // Chat address is its exact identity; ensure host records are installed after restart.
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    const observed = observeChatAssignee(chat, db)
    return {
      terminal: null,
      exact: true,
      status: observed.status,
      ...(observed.status === 'unverifiable' ? { reason: observed.reason } : {}),
      terminalHandle: null
    }
  }
  const structured = resolveStructuredWorkerForDispatch(db, dispatchId)
  if (!structured) {
    return null
  }
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  // Structured registry proves pane/lineage identity without a PTY.
  // Omit agentWait: terminal scans cannot see journal questions, and null falsely claims no wait.
  const exact = db.isDispatchProcessCurrent({
    dispatchId,
    paneKey: structured.paneKey,
    processIncarnation: structured.processIncarnation
  })
  const { addressable, ...observation } = observeStructuredWorkerHold(structured, db)
  return {
    terminal: null,
    exact,
    status: exact ? observation.status : 'identity_changed',
    ...(exact && observation.reason ? { reason: observation.reason } : {}),
    ...(exact && addressable !== null ? { addressable } : {}),
    terminalHandle: null
  }
}

/** One lineage walk, so status and `addressable` judge the same session even mid-`/clear`. */
export function observeStructuredWorkerHold(
  structured: StructuredWorkerIdentity,
  db: OrchestrationDb
): { status: 'live' | 'exited' | 'unverifiable'; reason?: string; addressable: boolean | null } {
  const hold = holdStructuredWorker(structured, db)
  if (hold.kind === 'unverifiable') {
    return { status: 'unverifiable', reason: hold.reason, addressable: null }
  }
  return { ...observeStructuredSession(hold.running.sessionId), addressable: hold.kind === 'held' }
}

/** Session verdicts read records that a restart leaves uninstalled until something asks. */
export async function ensureSessionWorkerRecords(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  rows: readonly { agentTerminalHandle: string | null }[]
): Promise<void> {
  if (
    rows.some(
      (row) =>
        chatAssigneeSessionId(row.agentTerminalHandle) ||
        isStructuredWorkerHandle(row.agentTerminalHandle)
    )
  ) {
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  }
}
