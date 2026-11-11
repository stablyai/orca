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
import { resolveStructuredWorkerForDispatch } from '../structured-workers/orchestration-structured-worker-lifecycle'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrchestrationWorkerSettings } from '../../../../../../shared/orchestration/workers/orchestration-worker-settings'

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
    terminalHandle: null
  }
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

/** Detailed inspection reads options without starting a child; a replaced owner invalidates the answer. */
export async function readStructuredWorkerSettings(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  db: OrchestrationDb,
  dispatchId: string
): Promise<OrchestrationWorkerSettings> {
  const identity = resolveStructuredWorkerForDispatch(db, dispatchId)
  if (!identity) {
    return { kind: 'unknown', reason: 'terminal_worker' }
  }
  try {
    await runtime.ensureStructuredAgentSessionHost()
    const host = getStructuredAgentSessionHost()
    if (!host) {
      return { kind: 'unknown', reason: 'host_unavailable' }
    }
    const held = holdStructuredWorker(identity, db)
    if (held.kind !== 'held') {
      return { kind: 'unknown', reason: 'not_held' }
    }
    const sessionId = held.running.sessionId
    const before = host.deps.store.getConversation(sessionId)
    if (!before || observeStructuredSession(sessionId).status !== 'live') {
      return { kind: 'unknown', reason: 'not_live' }
    }
    const options = await host.readOptions(sessionId, { readsWithoutModel: true })
    const after = host.deps.store.getConversation(sessionId)
    const currentHold = holdStructuredWorker(identity, db)
    if (
      currentHold.kind !== 'held' ||
      currentHold.running.sessionId !== sessionId ||
      after?.currentFence !== before.currentFence ||
      observeStructuredSession(sessionId).status !== 'live' ||
      !db.isDispatchProcessCurrent({
        dispatchId,
        paneKey: identity.paneKey,
        processIncarnation: identity.processIncarnation
      })
    ) {
      return { kind: 'unknown', reason: 'identity_changed' }
    }
    const {
      model,
      reportedModel,
      effort,
      reportedEffort,
      fastMode,
      serviceTier,
      interactionMode,
      permissionMode,
      reportedPermissionMode,
      fastModeState,
      acceptedInputSources,
      confirmed,
      defaulted
    } = options.current
    return {
      kind: 'options',
      sessionId,
      runtimeFence: before.currentFence,
      agent: before.provider,
      current: {
        model,
        reportedModel,
        effort,
        reportedEffort,
        fastMode,
        serviceTier,
        interactionMode,
        permissionMode,
        reportedPermissionMode,
        fastModeState,
        acceptedInputSources,
        confirmed,
        defaulted
      }
    }
  } catch {
    return { kind: 'unknown', reason: 'read_failed' }
  }
}
