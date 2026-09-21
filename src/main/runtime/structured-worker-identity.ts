/**
 * Orchestration identity for a NATIVE-BORN structured agent session.
 *
 * Orchestration derives a worker's identity and its lifecycle authority from a live PTY. A
 * structured session has none, so this registry is the second authority source: it maps a session
 * id onto the same three facts the PTY path supplies — a bearer handle, a stable pane key, and a
 * host scope — and nothing else about dispatch changes.
 *
 * The handle AND the pane key are both RANDOM on purpose. `orchestration.check` is identity-gated,
 * not capability-gated: it falls back to a caller-supplied `terminalPaneKey`
 * (`orchestration-check-methods.ts`) and dispatch lookup matches `assignee_pane_key` directly, so a
 * derivable pane key alone would let anyone who learns a session id read and consume that worker's
 * mailbox — and session ids are embedded in tab ids. PTY pane keys are safe only because their leaf
 * is a random UUID; these match that.
 */

import { randomUUID } from 'node:crypto'
import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import {
  parseWorkerTerminalHostScope,
  type WorkerTerminalHostScope
} from './orchestration/worker-terminal-process-liveness'

// Deliberately not `term_`: `issueHandle` revalidates the renderer graph epoch against the
// renderer-driven leaves map, so a main-minted `term_` leaf evaporates on the next window reload.
const STRUCTURED_WORKER_HANDLE_PREFIX = 'structworker_'
const STRUCTURED_WORKER_INCARNATION_PREFIX = 'structured:'

export type StructuredWorkerIdentity = {
  handle: string
  sessionId: string
  /** Null when the entry was rehydrated from the durable row, which does not carry the provider. */
  agent: 'claude' | 'codex' | null
  paneKey: string
  processIncarnation: string
  worktreeId: string
  hostScope: WorkerTerminalHostScope
}

export function isStructuredWorkerHandle(handle: string | null | undefined): boolean {
  return typeof handle === 'string' && handle.startsWith(STRUCTURED_WORKER_HANDLE_PREFIX)
}

export function mintStructuredWorkerHandle(): string {
  return `${STRUCTURED_WORKER_HANDLE_PREFIX}${randomUUID()}`
}

/**
 * A RANDOM leaf, minted once per worker and persisted with the rest of the identity.
 *
 * Emphatically not `structuredAgentSessionPaneKey`, which is a sha256 of the session id. A pane
 * key is an identity credential on its own: `orchestration.check` is identity-gated, not
 * capability-gated, and accepts a caller-supplied `terminalPaneKey` that `getActiveDispatchForIdentity`
 * matches by leaf suffix. A derivable pane key would therefore let anyone who learns a session id —
 * which the tab id embeds in plain text — read and consume that worker's mailbox with no token.
 * PTY pane keys are safe only because their leaf UUID is random; this one has to be too.
 *
 * Restart stability comes from persisting the minted key, not from re-deriving it.
 */
export function mintStructuredWorkerPaneKey(sessionId: string): string {
  return makePaneKey(structuredAgentSessionTabId(sessionId), randomUUID())
}

/** Integrity check for a persisted pane key: same session's tab, and a real terminal leaf. */
export function structuredWorkerPaneKeyBelongsToSession(
  paneKey: string | null | undefined,
  sessionId: string
): boolean {
  const parsed = paneKey ? parsePaneKey(paneKey) : null
  return Boolean(
    parsed &&
    parsed.tabId === structuredAgentSessionTabId(sessionId) &&
    isTerminalLeafId(parsed.leafId)
  )
}

/**
 * Process continuity for a structured worker.
 *
 * NOT the runtime fence: the fence is an owner-generation counter that the host bumps during its
 * own transparent crash recovery, so fencing identity on it would make a recovered — but same —
 * worker fail `verifyDispatchCapability` forever and wedge release as `identity_unproven`. The
 * session id is minted once per dispatch and survives that recovery, so it is the lineage.
 */
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

/** Structured sessions can only exist local and outside WSL; anything else is not our authority. */
export function structuredWorkerHostScope(
  location: AgentSessionExecutionLocation
): WorkerTerminalHostScope | null {
  return location.executionHostId === LOCAL_EXECUTION_HOST_ID && !location.wslDistro
    ? { kind: 'local', hostId: 'local' }
    : null
}

/** Whether the durable record still describes THIS worker under this host. */
export function structuredWorkerRecordIsCurrent(
  record: AgentSessionRecord | null | undefined
): boolean {
  return Boolean(
    record &&
    record.lease.runtimeKind === 'native' &&
    record.lease.claimStatus !== 'released' &&
    structuredWorkerHostScope(record.location)
  )
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

  /**
   * Rebuilds an entry from the durable worker-terminal resource row after a restart, which is the
   * only place a structured worker's pane key and host scope outlive this process. A row whose
   * pane key does not belong to its own recorded session is refused rather than trusted.
   */
  rehydrate(row: {
    terminal_handle: string
    pane_key: string | null
    process_incarnation: string | null
    worktree_id: string | null
    host_scope: string | null
  }): StructuredWorkerIdentity | null {
    const sessionId = sessionIdFromStructuredWorkerIncarnation(row.process_incarnation)
    const hostScope = parseWorkerTerminalHostScope(row.host_scope)
    if (
      !sessionId ||
      !hostScope ||
      !row.worktree_id ||
      !isStructuredWorkerHandle(row.terminal_handle) ||
      // The leaf is random, so the row IS the only source for it; verify only that it is a real
      // leaf under this session's tab rather than trying to re-derive it.
      !structuredWorkerPaneKeyBelongsToSession(row.pane_key, sessionId)
    ) {
      return null
    }
    return this.register({
      handle: row.terminal_handle,
      sessionId,
      // The row does not carry the provider; callers that need it read the durable record.
      agent: null,
      paneKey: row.pane_key as string,
      processIncarnation: structuredWorkerProcessIncarnation(sessionId),
      worktreeId: row.worktree_id,
      hostScope
    })
  }

  clear(): void {
    this.byHandle.clear()
    this.bySessionId.clear()
  }
}

export const structuredWorkerIdentities = new StructuredWorkerIdentityRegistry()
