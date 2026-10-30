import type { OrchestrationPartyLocationResult } from '../../../shared/orchestration-caller-status'
import type { OrcaSessionId } from '../../../shared/orca-session-address'
import type { OrchestrationDb } from './db'
import { resolveOrchestrationParty } from './orchestration-party'
import { OrchestrationError } from './orchestration-error'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import { lineageLiveSession, type AgentSessionRecordReader } from './structured-session-lineage'

type PartyLocationDeps = {
  db: OrchestrationDb | null
  records: AgentSessionRecordReader | null
  /** Non-null only for a handle this runtime issued. */
  terminalPaneKey: (handle: string) => string | null
  terminalHandleForPaneKey: (paneKey: string) => string | null
}

/** Locate through sender provenance in these messageIds, which survives handle reissue. */
export function locateOrchestrationParty(
  address: string,
  deps: PartyLocationDeps,
  messageIds: readonly string[] = []
): OrchestrationPartyLocationResult {
  if (address.startsWith('dispatch:')) {
    return locateDispatchAssignee(address.slice('dispatch:'.length), deps)
  }
  let party: ReturnType<typeof resolveOrchestrationParty>
  try {
    party = resolveOrchestrationParty(address, deps.db)
  } catch (error) {
    // Only proven lost worker identity means gone; other resolution failures remain unreachable.
    if (error instanceof OrchestrationError && error.code === CODES.notLive) {
      return { location: null, lost: 'chat' }
    }
    throw error
  }
  if (party.orcaSessionId) {
    return locateSession(party.orcaSessionId, deps.records)
  }
  return party.terminalHandle
    ? locateTerminal(party.terminalHandle, deps, messageIds)
    : { location: null, lost: 'terminal' }
}

/** Recover previous-run handles through the pane recorded on their sent mail. */
function locateTerminal(
  handle: string,
  deps: PartyLocationDeps,
  messageIds: readonly string[]
): OrchestrationPartyLocationResult {
  if (deps.terminalPaneKey(handle) !== null) {
    return { location: { kind: 'terminal', handle } }
  }
  for (const messageId of messageIds) {
    const message = deps.db?.getMessageById(messageId)
    const paneKey = message?.from_handle === handle ? message.sender_pane_key : null
    const live = paneKey ? deps.terminalHandleForPaneKey(paneKey) : null
    if (live) {
      return { location: { kind: 'terminal', handle: live } }
    }
  }
  return { location: null, lost: 'terminal' }
}

/** Resolve assignee pane, handle or remote attachment; absence at a federated Run home never proves worker exit. */
function locateDispatchAssignee(
  dispatchId: string,
  deps: PartyLocationDeps
): OrchestrationPartyLocationResult {
  const dispatch = deps.db?.getDispatchContextById(dispatchId)
  if (dispatch?.assignee_orca_session_id) {
    return locateSession(dispatch.assignee_orca_session_id, deps.records)
  }
  const remote = dispatch ? undefined : deps.db?.getRemoteDispatchAttachment(dispatchId)
  const paneKey = dispatch?.assignee_pane_key ?? remote?.pane_key
  const handle =
    (paneKey ? deps.terminalHandleForPaneKey(paneKey) : null) ??
    dispatch?.assignee_handle ??
    remote?.terminal_handle
  return handle && !handle.startsWith('dispatch:')
    ? locateOrchestrationParty(handle, deps)
    : { location: null }
}

function locateSession(
  orcaSessionId: OrcaSessionId,
  records: AgentSessionRecordReader | null
): OrchestrationPartyLocationResult {
  const record = records ? lineageLiveSession(records, orcaSessionId) : null
  return record
    ? {
        location: {
          kind: 'chat',
          sessionId: record.sessionId,
          worktreeId: record.location.workspaceId
        }
      }
    : { location: null, lost: 'chat' }
}
