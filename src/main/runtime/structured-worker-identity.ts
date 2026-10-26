/** Structured workers have no PTY; register their bearer handle, pane key and host scope as orchestration authority.
 * Random handles and leaves prevent session ids exposed in tab ids from yielding caller-supplied keys that read/consume worker mail. */

import { randomUUID } from 'node:crypto'
import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { isOrcaSessionId, type OrcaSessionId } from '../../shared/orca-session-address'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  STRUCTURED_WORKER_HANDLE_PREFIX,
  isStructuredWorkerHandle
} from '../../shared/structured-worker-handle'
import {
  parseWorkerTerminalHostScope,
  type WorkerTerminalHostScope
} from '../../shared/worker-terminal-host-scope'

export const STRUCTURED_WORKER_INCARNATION_PREFIX = 'structured:'

export type StructuredWorkerIdentity = {
  handle: string
  /** Minted session/clear-lineage root keys worker identity; resolve the current successor through structuredWorkerSession. */
  sessionId: string
  /** Null when the entry was rehydrated from the durable row, which does not carry the provider. */
  agent: TuiAgent | null
  paneKey: string
  processIncarnation: string
  worktreeId: string
  hostScope: WorkerTerminalHostScope
}

export function mintStructuredWorkerHandle(): string {
  return `${STRUCTURED_WORKER_HANDLE_PREFIX}${randomUUID()}`
}

/** Mint and persist a random leaf: paired/PTY-style check callers can supply pane keys and match by leaf suffix.
 * Never derive it like structuredAgentSessionPaneKey; session ids are public in tab ids. Same-host session-id authority remains separate. */
export function mintStructuredWorkerPaneKey(sessionId: string): string {
  return makePaneKey(structuredAgentSessionTabId(sessionId), randomUUID())
}

/** Credential check: only the pane key registered for this session can prove its identity. */
export function structuredWorkerPaneKeyBelongsToSession(
  paneKey: string | null | undefined,
  sessionId: string
): boolean {
  const registered = structuredWorkerIdentities.getBySessionId(sessionId)
  const parsed = paneKey ? parsePaneKey(paneKey) : null
  return Boolean(
    registered &&
    registered.paneKey === paneKey &&
    parsed &&
    parsed.tabId === structuredAgentSessionTabId(sessionId)
  )
}

/** Bootstrap validation for a durable row before its key can enter the registry. */
function persistedStructuredWorkerPaneKeyIsValid(
  paneKey: string | null | undefined,
  sessionId: string
): paneKey is string {
  const parsed = paneKey ? parsePaneKey(paneKey) : null
  return Boolean(
    paneKey &&
    paneKey !== structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId) &&
    parsed &&
    parsed.tabId === structuredAgentSessionTabId(sessionId) &&
    isTerminalLeafId(parsed.leafId)
  )
}

/** Use stable session lineage for process continuity; transparent crash recovery bumps the owner fence and must not wedge the same worker as identity_unproven. */
export function structuredWorkerProcessIncarnation(sessionId: string): string {
  return `${STRUCTURED_WORKER_INCARNATION_PREFIX}${sessionId}`
}

export function sessionIdFromStructuredWorkerIncarnation(
  processIncarnation: string | null | undefined
): string | null {
  if (!processIncarnation?.startsWith(STRUCTURED_WORKER_INCARNATION_PREFIX)) {
    return null
  }
  const sessionId = processIncarnation.slice(STRUCTURED_WORKER_INCARNATION_PREFIX.length)
  return sessionId.length > 0 ? sessionId : null
}

/** The Orca session id a `structured:<sessionId>` incarnation names; null for any other. */
export function structuredWorkerOrcaSessionIdForIncarnation(
  processIncarnation: string | null | undefined
): OrcaSessionId | null {
  const sessionId = sessionIdFromStructuredWorkerIncarnation(processIncarnation)
  return sessionId !== null && isOrcaSessionId(sessionId) ? sessionId : null
}

/** Structured sessions can only exist local and outside WSL; anything else is not our authority. */
export function structuredWorkerHostScope(
  location: AgentSessionExecutionLocation
): WorkerTerminalHostScope | null {
  return location.executionHostId === LOCAL_EXECUTION_HOST_ID && !location.wslDistro
    ? { kind: 'local', hostId: 'local' }
    : null
}

/** Judge ownership, not liveness: a released lease stays current while its persisted chat tab is listed. */
export function structuredWorkerRecordIsCurrent(
  record: AgentSessionRecord | null | undefined,
  tabListed: boolean
): boolean {
  return Boolean(
    record &&
    // Why: a conflicted claim may name a terminal an older build recorded as owner, not this worker.
    record.lease.claimStatus !== 'conflicted' &&
    (record.lease.claimStatus !== 'released' || tabListed) &&
    structuredWorkerHostScope(record.location)
  )
}

type StructuredWorkerResourceRow = {
  terminal_handle: string
  pane_key: string | null
  process_incarnation: string | null
  worktree_id: string | null
  host_scope: string | null
}

/** Rehydrate only structured rows with valid session-bound pane key and host scope. */
export function structuredWorkerIdentityFromRow(
  row: StructuredWorkerResourceRow
): StructuredWorkerIdentity | null {
  const sessionId = sessionIdFromStructuredWorkerIncarnation(row.process_incarnation)
  const hostScope = parseWorkerTerminalHostScope(row.host_scope)
  const paneKey = row.pane_key
  if (
    !sessionId ||
    !hostScope ||
    !row.worktree_id ||
    !paneKey ||
    !isStructuredWorkerHandle(row.terminal_handle) ||
    !persistedStructuredWorkerPaneKeyIsValid(paneKey, sessionId)
  ) {
    return null
  }
  return {
    handle: row.terminal_handle,
    sessionId,
    // The row does not carry the provider; callers that need it read the durable record.
    agent: null,
    paneKey,
    processIncarnation: structuredWorkerProcessIncarnation(sessionId),
    worktreeId: row.worktree_id,
    hostScope
  }
}

export class StructuredWorkerIdentityRegistry {
  private readonly byHandle = new Map<string, StructuredWorkerIdentity>()
  private readonly bySessionId = new Map<string, StructuredWorkerIdentity>()

  register(identity: StructuredWorkerIdentity): StructuredWorkerIdentity {
    this.byHandle.set(identity.handle, identity)
    this.bySessionId.set(identity.sessionId, identity)
    return identity
  }

  get(handle: string): StructuredWorkerIdentity | null {
    return this.byHandle.get(handle) ?? null
  }

  getBySessionId(sessionId: string): StructuredWorkerIdentity | null {
    return this.bySessionId.get(sessionId) ?? null
  }

  /** Every worker this process knows about; callers apply their own liveness gate. */
  list(): StructuredWorkerIdentity[] {
    return [...this.byHandle.values()]
  }

  forget(handle: string): void {
    const identity = this.byHandle.get(handle)
    if (!identity) {
      return
    }
    this.byHandle.delete(handle)
    if (this.bySessionId.get(identity.sessionId) === identity) {
      this.bySessionId.delete(identity.sessionId)
    }
  }

  /** Recover persisted pane key/host scope after restart; reject a key not bound to its recorded session. */
  rehydrate(row: StructuredWorkerResourceRow): StructuredWorkerIdentity | null {
    const identity = structuredWorkerIdentityFromRow(row)
    return identity ? this.register(identity) : null
  }

  clear(): void {
    this.byHandle.clear()
    this.bySessionId.clear()
  }
}

export const structuredWorkerIdentities = new StructuredWorkerIdentityRegistry()
