/**
 * Host-side registry that maps a live PTY to the durable agent session it belongs to, and answers
 * whether bytes may enter that PTY right now.
 *
 * It lives on the execution host that owns the process, never in a client: a paired desktop, a
 * mobile client, and an SSH-attached Orca all reach the same gate through the host that spawned
 * the PTY. With nothing bound — the state of every build until a later part registers records —
 * `admit` short-circuits to admitted, so no existing terminal path changes behavior or cost.
 */

import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  AgentSessionPtyWriteRefusedError,
  evaluateAgentSessionPtyWriteAdmission,
  reevaluateAgentSessionPtyWriteAdmission,
  type AgentSessionPtyBinding,
  type AgentSessionPtyWriteAdmission
} from '../../shared/agent-session-pty-write-admission'

export type AgentSessionRecordLookup = (sessionId: string) => AgentSessionRecord | null

/** What an admitted write carries forward so its later chunks can be fenced against the same lease. */
export type AgentSessionPtyWriteAdmittance = {
  sessionId: string | null
  runtimeFence: number | null
}

const ADMITTED_UNBOUND: AgentSessionPtyWriteAdmission = {
  admitted: true,
  sessionId: null,
  runtimeFence: null
}

/**
 * A pane binding, plus the adoption attempt that is still proving it.
 *
 * `attemptToken` is null once an owner is proven — a settled binding no attempt may take away.
 * While it is non-null the binding belongs to that one in-flight attempt, which is the only thing
 * that tells two overlapping adoptions apart: both carry the same sessionId.
 */
type BoundPane = { sessionId: string; attemptToken: string | null }

export class AgentSessionPtyWriteGate {
  private readonly panesByPtyId = new Map<string, BoundPane>()
  private lookup: AgentSessionRecordLookup | null = null

  /** Point the gate at the durable store. Until this is called nothing can be enforced. */
  attachRecordLookup(lookup: AgentSessionRecordLookup): void {
    this.lookup = lookup
  }

  detachRecordLookup(): void {
    this.lookup = null
    this.panesByPtyId.clear()
  }

  bindPty(ptyId: string, sessionId: string): void {
    this.panesByPtyId.set(ptyId, { sessionId, attemptToken: null })
  }

  unbindPty(ptyId: string): void {
    this.panesByPtyId.delete(ptyId)
  }

  /**
   * Claim the pane for one adoption attempt, identified by the spawn token its reservation minted.
   * A settled owner keeps the pane; another attempt's claim is superseded, because the newest
   * reservation is the one the record now names. Callers must already have refused a pane bound to
   * a different session.
   */
  bindPtyForAttempt(ptyId: string, sessionId: string, attemptToken: string): boolean {
    const current = this.panesByPtyId.get(ptyId)
    if (current && current.attemptToken === null) {
      return false
    }
    this.panesByPtyId.set(ptyId, { sessionId, attemptToken })
    return true
  }

  /** Promote this attempt's claim to a settled binding once its owner is proven. */
  settlePtyAttempt(ptyId: string, attemptToken: string): boolean {
    const current = this.panesByPtyId.get(ptyId)
    if (current?.attemptToken !== attemptToken) {
      return false
    }
    this.panesByPtyId.set(ptyId, { sessionId: current.sessionId, attemptToken: null })
    return true
  }

  /**
   * Compare-and-clear: hand the pane back only while this attempt still holds it. A losing attempt
   * that unbinds by pty alone rips the pane out from under the attempt that superseded it, and then
   * that one's proof is refused too — both fail where one should have won.
   */
  releasePtyAttempt(ptyId: string, attemptToken: string): boolean {
    if (this.panesByPtyId.get(ptyId)?.attemptToken !== attemptToken) {
      return false
    }
    this.panesByPtyId.delete(ptyId)
    return true
  }

  boundSessionId(ptyId: string): string | null {
    return this.panesByPtyId.get(ptyId)?.sessionId ?? null
  }

  /** False while no PTY is bound, which is every write path in today's builds. */
  get enforcing(): boolean {
    return this.lookup !== null && this.panesByPtyId.size > 0
  }

  admit(ptyId: string): AgentSessionPtyWriteAdmission {
    if (!this.enforcing) {
      return ADMITTED_UNBOUND
    }
    return evaluateAgentSessionPtyWriteAdmission(this.binding(ptyId))
  }

  /** Narrow pre-ownership input for the reserved TUI's provider identity probe. */
  admitProof(ptyId: string, authority: { sessionId: string; spawnToken: string }): boolean {
    const binding = this.binding(ptyId)
    const lease = binding?.record?.lease
    const provingReservation =
      lease?.claimStatus === 'reserved' &&
      lease.handoffStage === 'new-owner-proving' &&
      lease.reservedSpawnToken === authority.spawnToken &&
      (lease.ownerProcess === null || lease.ownerProcess.spawnToken === authority.spawnToken)
    const reprovingLiveOwner =
      lease?.claimStatus === 'live' &&
      lease.handoffStage === null &&
      lease.ownerProcess?.spawnToken === authority.spawnToken &&
      lease.provenHandleLinkId !== null
    return Boolean(
      binding?.sessionId === authority.sessionId &&
      binding.record?.sessionId === authority.sessionId &&
      lease?.runtimeKind === 'tui' &&
      (provingReservation || reprovingLiveOwner) &&
      !lease.unreconciled
    )
  }

  /** Re-check a write already in flight against the fence it was admitted under. */
  readmit(ptyId: string, admitted: AgentSessionPtyWriteAdmittance): AgentSessionPtyWriteAdmission {
    if (admitted.sessionId === null && !this.enforcing) {
      return ADMITTED_UNBOUND
    }
    return reevaluateAgentSessionPtyWriteAdmission({ admitted, binding: this.binding(ptyId) })
  }

  /** Admit or throw the typed refusal. Used where the caller already reports errors to a client. */
  assertAdmitted(ptyId: string): AgentSessionPtyWriteAdmittance {
    const admission = this.admit(ptyId)
    if (!admission.admitted) {
      throw new AgentSessionPtyWriteRefusedError(admission.refusal)
    }
    return { sessionId: admission.sessionId, runtimeFence: admission.runtimeFence }
  }

  assertReadmitted(ptyId: string, admitted: AgentSessionPtyWriteAdmittance): void {
    const admission = this.readmit(ptyId, admitted)
    if (!admission.admitted) {
      throw new AgentSessionPtyWriteRefusedError(admission.refusal)
    }
  }

  private binding(ptyId: string): AgentSessionPtyBinding | null {
    const pane = this.panesByPtyId.get(ptyId)
    if (pane === undefined) {
      return null
    }
    return { sessionId: pane.sessionId, record: this.lookup?.(pane.sessionId) ?? null }
  }
}

/**
 * One gate per host process. Both the runtime's send paths and the PTY IPC layer consult this same
 * instance, so a write cannot reach a provider by entering through the other door.
 */
export const agentSessionPtyWriteGate = new AgentSessionPtyWriteGate()
