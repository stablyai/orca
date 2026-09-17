import {
  createAgentTurnLifecycleState,
  isAgentTurnOwner,
  readAgentTurnLifecycleSnapshot,
  reduceAgentTurnLifecycle,
  type AgentTurnLifecycleEvent,
  type AgentTurnLifecycleReduction,
  type AgentTurnLifecycleSnapshot,
  type AgentTurnOwner
} from '../../../shared/agent-turn-lifecycle'
import { agentTurnOwnersEqual } from '../../../shared/agent-turn-lifecycle-state'
import { boundedAgentTurnEvidenceId } from '../../../shared/agent-turn-evidence-id'
import type { AgentStatusRunVerdict } from '../../../shared/agent-status-run'
import { providerEvidenceToLifecycleEvents } from '../../../shared/agent-hook-listener/provider-turn-lifecycle'
import {
  readProviderTerminalTurnRecord,
  type ProviderTurnEvidence
} from '../../../shared/agent-hook-listener/provider-turn-evidence'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { isValidPaneKey } from './server-status-identity'
import { AgentHookServerState } from './server-state'
import { agentExecutionVerdictEvent } from './server-turn-lifecycle-event'

export type AgentTurnLifecycleChange = {
  paneKey: string
  snapshot: AgentTurnLifecycleSnapshot
  reduction: AgentTurnLifecycleReduction
}

/** Host-local adapter that feeds provider facts into C1's canonical reducer. */
export abstract class AgentHookServerTurnLifecycle extends AgentHookServerState {
  private readonly agentTurnLifecycleListeners = new Set<
    (change: AgentTurnLifecycleChange) => void
  >()

  /** Bind one committed/adopted C5 execution owner to its concrete pane attachment. */
  registerAgentTurnOwner(paneKey: string, owner: AgentTurnOwner): boolean {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey.trim())
    if (!isValidPaneKey(resolvedPaneKey) || !isAgentTurnOwner(owner)) {
      return false
    }
    const existing = this.agentTurnLifecycleByPaneKey.get(resolvedPaneKey)
    if (existing && agentTurnOwnersEqual(existing.owner, owner)) {
      return true
    }
    this.agentTurnLifecycleByPaneKey.set(resolvedPaneKey, {
      owner,
      state: createAgentTurnLifecycleState(owner)
    })
    return true
  }

  /** Remove an owner binding only when the caller still holds that exact binding. */
  unregisterAgentTurnOwner(paneKey: string, owner: AgentTurnOwner): boolean {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey.trim())
    const existing = this.agentTurnLifecycleByPaneKey.get(resolvedPaneKey)
    if (!existing || !isAgentTurnOwner(owner) || !agentTurnOwnersEqual(existing.owner, owner)) {
      return false
    }
    this.agentTurnLifecycleByPaneKey.delete(resolvedPaneKey)
    return true
  }

  getAgentTurnLifecycleSnapshot(paneKey: string): AgentTurnLifecycleSnapshot | null {
    const registration = this.agentTurnLifecycleByPaneKey.get(
      this.resolvePaneKeyAlias(paneKey.trim())
    )
    return registration ? readAgentTurnLifecycleSnapshot(registration.state) : null
  }

  subscribeAgentTurnLifecycle(listener: (change: AgentTurnLifecycleChange) => void): () => void {
    this.agentTurnLifecycleListeners.add(listener)
    return () => this.agentTurnLifecycleListeners.delete(listener)
  }

  _resetAgentTurnLifecycleForTests(): void {
    this.agentTurnLifecycleByPaneKey.clear()
  }

  /** Apply provider facts through the canonical reducer; adapters never own semantic state. */
  protected applyProviderTurnEvidence(payload: AgentHookEventPayload): void {
    if (!payload.providerTurnEvidence || payload.providerTurnEvidence.length === 0) {
      return
    }
    const paneKey = this.resolvePaneKeyAlias(payload.paneKey)
    const registration = this.agentTurnLifecycleByPaneKey.get(paneKey)
    if (!registration || (payload.source && payload.source !== registration.owner.provider)) {
      return
    }
    // A certified exit ends this attachment. A replacement must register a new owner before
    // late provider delivery can be considered again.
    if (registration.state.executionVerdict === 'exited') {
      return
    }
    for (const evidence of payload.providerTurnEvidence) {
      this.applyProviderEvidence(paneKey, registration.owner, evidence)
    }
  }

  protected applyProviderEvidence(
    paneKey: string,
    owner: AgentTurnOwner,
    evidence: ProviderTurnEvidence
  ): AgentTurnLifecycleReduction | null {
    const registration = this.agentTurnLifecycleByPaneKey.get(paneKey)
    if (!registration || !agentTurnOwnersEqual(registration.owner, owner)) {
      return null
    }
    if (registration.state.executionVerdict === 'exited') {
      return null
    }
    const events = providerEvidenceToLifecycleEvents(owner, evidence)
    let lastReduction: AgentTurnLifecycleReduction | null = null
    for (const event of events) {
      lastReduction = this.reduceAgentTurnEvent(paneKey, event)
    }
    return lastReduction
  }

  protected reduceAgentTurnEvent(
    paneKey: string,
    event: AgentTurnLifecycleEvent
  ): AgentTurnLifecycleReduction | null {
    const registration = this.agentTurnLifecycleByPaneKey.get(paneKey)
    if (!registration) {
      return null
    }
    const reduction = reduceAgentTurnLifecycle(registration.state, event)
    // The reducer records ignored/conflicting evidence and its dedupe key in the returned state;
    // retaining only accepted transitions would make malformed or stale facts replay forever.
    registration.state = reduction.state
    const change = {
      paneKey,
      snapshot: readAgentTurnLifecycleSnapshot(registration.state),
      reduction
    }
    for (const listener of this.agentTurnLifecycleListeners) {
      try {
        listener(change)
      } catch (error) {
        console.error('[agent-hooks] lifecycle listener threw', error)
      }
    }
    return reduction
  }

  observeAgentExecutionVerdict(
    paneKey: string,
    verdict: AgentStatusRunVerdict,
    observedAt = Date.now()
  ): AgentTurnLifecycleReduction | null {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey.trim())
    const registration = this.agentTurnLifecycleByPaneKey.get(resolvedPaneKey)
    if (!registration) {
      return null
    }
    return this.reduceAgentTurnEvent(
      resolvedPaneKey,
      agentExecutionVerdictEvent(registration.owner, verdict, observedAt)
    )
  }

  recordAgentTurnInterruptInputWritten(
    paneKey: string,
    observedAt = Date.now()
  ): AgentTurnLifecycleReduction | null {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey.trim())
    const registration = this.agentTurnLifecycleByPaneKey.get(resolvedPaneKey)
    const turnId = registration?.state.currentTurnId
    if (!registration || !turnId) {
      return null
    }
    return this.reduceAgentTurnEvent(resolvedPaneKey, {
      kind: 'turn-interrupt-input-written',
      owner: registration.owner,
      turnId,
      writtenAt: observedAt,
      evidence: {
        eventId: boundedAgentTurnEvidenceId(`interrupt-input-written:${turnId}:${observedAt}`),
        producerId: 'orc:pty-input',
        observedAt
      }
    })
  }

  requestAgentTurnInterrupt(
    paneKey: string,
    observedAt = Date.now()
  ): AgentTurnLifecycleReduction | null {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey.trim())
    const registration = this.agentTurnLifecycleByPaneKey.get(resolvedPaneKey)
    const turnId = registration?.state.currentTurnId
    if (!registration || !turnId) {
      return null
    }
    return this.reduceAgentTurnEvent(resolvedPaneKey, {
      kind: 'turn-interrupt-requested',
      owner: registration.owner,
      turnId,
      evidence: {
        eventId: boundedAgentTurnEvidenceId(`interrupt-requested:${turnId}:${observedAt}`),
        producerId: 'orc:interrupt-request',
        observedAt
      }
    })
  }

  startAgentTurnRecovery(
    paneKey: string,
    custodyId: string,
    deadlineAt: number,
    observedAt = Date.now()
  ): AgentTurnLifecycleReduction | null {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey.trim())
    const registration = this.agentTurnLifecycleByPaneKey.get(resolvedPaneKey)
    const turnId = registration?.state.currentTurnId
    if (!registration || !turnId) {
      return null
    }
    return this.reduceAgentTurnEvent(resolvedPaneKey, {
      kind: 'turn-recovery-started',
      owner: registration.owner,
      turnId,
      custodyId,
      deadlineAt,
      evidence: {
        eventId: boundedAgentTurnEvidenceId(`turn-recovery-started:${custodyId}`),
        producerId: 'orc:turn-recovery',
        observedAt
      }
    })
  }

  expireAgentTurnRecovery(
    paneKey: string,
    turnId: string,
    custodyId: string,
    observedAt = Date.now()
  ): AgentTurnLifecycleReduction | null {
    return this.reduceRecoveryEvent(paneKey, 'turn-recovery-expired', turnId, custodyId, observedAt)
  }

  abandonAgentTurnRecovery(
    paneKey: string,
    turnId: string,
    custodyId: string,
    observedAt = Date.now()
  ): AgentTurnLifecycleReduction | null {
    return this.reduceRecoveryEvent(
      paneKey,
      'turn-recovery-abandoned',
      turnId,
      custodyId,
      observedAt
    )
  }

  ingestProviderTerminalTurnRecord(
    paneKey: string,
    input: Omit<
      Parameters<typeof readProviderTerminalTurnRecord>[0],
      'paneKey' | 'source' | 'runId' | 'executionId'
    >
  ): AgentTurnLifecycleReduction | null {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey.trim())
    const registration = this.agentTurnLifecycleByPaneKey.get(resolvedPaneKey)
    if (!registration) {
      return null
    }
    const read = readProviderTerminalTurnRecord({
      ...input,
      paneKey: resolvedPaneKey,
      source: registration.owner.provider,
      runId: registration.owner.runId,
      executionId: registration.owner.attachment.executionId
    })
    let reduction: AgentTurnLifecycleReduction | null = null
    for (const evidence of read.evidence) {
      reduction = this.applyProviderEvidence(resolvedPaneKey, registration.owner, evidence)
    }
    return reduction
  }

  private reduceRecoveryEvent(
    paneKey: string,
    kind: 'turn-recovery-expired' | 'turn-recovery-abandoned',
    turnId: string,
    custodyId: string,
    observedAt: number
  ): AgentTurnLifecycleReduction | null {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey.trim())
    const registration = this.agentTurnLifecycleByPaneKey.get(resolvedPaneKey)
    if (!registration) {
      return null
    }
    return this.reduceAgentTurnEvent(resolvedPaneKey, {
      kind,
      owner: registration.owner,
      turnId,
      custodyId,
      evidence: {
        // Include the observation time so a stale expiry attempt cannot consume the valid
        // deadline-bound event as a duplicate.
        eventId: boundedAgentTurnEvidenceId(`${kind}:${custodyId}:${observedAt}`),
        producerId: 'orc:turn-recovery',
        observedAt
      }
    })
  }
}
