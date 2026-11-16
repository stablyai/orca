import { AgentHookServerPaneSleep } from './server-pane-sleep'
import type { AgentProcessPresence } from '../../../shared/agent-status/process/agent-process-presence'
import {
  admitLegacyAgentStatus,
  clearPaneCacheState,
  deleteLegacyAgentStatus
} from '../../../shared/agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status/transport/agent-status-legacy-adapter'
import type { AgentStatusCacheIdentity } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  parseExecutionHostId,
  type ExecutionHostScope
} from '../../../shared/execution-host/execution-host'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import { isLocalHookConnectionId } from '../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'
import type { EnrichedAgentHookEventPayload } from './server-types'

import { endedPresenceOf } from './agent-exit-evidence'

export type EndedProcessReconciliationOptions = {
  endedPresence?: AgentProcessPresence
  /** The pane's shell is back: a process-less owner ended. 'proven' when the host's process
   *  table found the shell alone, not only a command mark standing. */
  confirmedExit?: boolean | 'proven'
  /** Keep resume identity when the pane survives the agent. */
  preserveResumeIdentity?: boolean
  /** One pane's identity, already read while its row stayed unchanged. */
  known?: { paneKey: string; identity: ReturnType<AgentHookServerCleanup['paneAgentIdentity']> }
}

export abstract class AgentHookServerCleanup extends AgentHookServerPaneSleep {
  /** Resume identity survives teardown without claiming live work. */
  protected toRetainedProviderSessionRow(
    entry: EnrichedAgentHookEventPayload | null | undefined
  ): EnrichedAgentHookEventPayload | null {
    if (
      !entry?.providerSession ||
      !entry.payload.agentType ||
      entry.payload.agentType === 'unknown'
    ) {
      return null
    }
    const { launchToken: _launchToken, paneSleep: _paneSleep, ...resumeIdentity } = entry
    return { ...resumeIdentity, providerSessionOnly: true, retainedForLiveness: true }
  }

  /** Dismiss the row while preserving the live agent's caches; PTY teardown uses clearPaneState. */
  dropStatusEntry(
    paneKey: string,
    /** Structured sessions store resume identity elsewhere and opt out. */
    options?: { preserveResumeIdentity?: boolean }
  ): void {
    const deleted = this.deleteStatusEntry(paneKey, { preserveAuthority: true })
    if (!deleted) {
      return
    }
    const retained =
      options?.preserveResumeIdentity === false ? null : this.toRetainedProviderSessionRow(deleted)
    if (retained) {
      admitLegacyAgentStatus(
        this.state,
        'main-status-cleanup',
        retained,
        AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
      )
    }
    this.commitStatusRowMutation(deleted, retained)
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    this.emitStatusDropped(deleted.paneKey)
  }

  /** Persist and notify once for the evicted batch. */
  dropPersistedStatusEntries(identities: readonly AgentStatusCacheIdentity[]): string[] {
    const evicted: string[] = []
    for (const identity of identities) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(identity.paneKey)
      const existing = this.state.lastStatusByPaneKey.get(resolvedPaneKey) as
        | EnrichedAgentHookEventPayload
        | undefined
      const canonical = existing ?? this.getTmuxSelectedStatus(resolvedPaneKey)
      // The turn clock pins identity; renderer updatedAt is at least receivedAt, so protect only newer rows.
      if (
        !canonical ||
        canonical.stateStartedAt !== identity.stateStartedAt ||
        canonical.receivedAt > identity.receivedAt
      ) {
        continue
      }
      const deleted = this.deleteStatusEntry(resolvedPaneKey, { preserveAuthority: true })
      if (!deleted) {
        continue
      }
      const retained = this.toRetainedProviderSessionRow(deleted)
      if (retained) {
        admitLegacyAgentStatus(
          this.state,
          'main-status-cleanup',
          retained,
          AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
        )
      }
      this.commitStatusRowMutation(deleted, retained)
      evicted.push(deleted.paneKey)
    }
    if (evicted.length === 0) {
      return evicted
    }
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    for (const paneKey of evicted) {
      this.emitStatusDropped(paneKey)
    }
    return evicted
  }

  /** Reconcile dead panes whose restored PTYs may never rebuild the spawn-time ptyPaneKey mapping. */
  protected reconcileEndedProcess(
    paneKeys: Iterable<string>,
    options: EndedProcessReconciliationOptions | undefined,
    clearPane: (paneKey: string) => void
  ): { cleared: number; untouched: string[] } {
    const untouched: string[] = []
    let cleared = 0
    for (const paneKey of paneKeys) {
      const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
      if (this.preservesStoppingAgent(resolvedPaneKey)) {
        untouched.push(resolvedPaneKey)
        continue
      }
      const previous = this.state.lastStatusByPaneKey.get(resolvedPaneKey) as
        | EnrichedAgentHookEventPayload
        | undefined
      let identity =
        options?.known?.paneKey === resolvedPaneKey ? options.known.identity : undefined
      const identityOf = () =>
        identity === undefined ? (identity = this.paneAgentIdentity(resolvedPaneKey)) : identity
      const endedPresence =
        options?.endedPresence ??
        // A process the presence probe reaches gets its exit from the probe, not a possibly newer
        // row (WSL/SSH have no probe, so their mark stands); a shared server (tmux, OpenCode)
        // outlives the command that finished at the pane's shell.
        (options?.confirmedExit &&
        (!previous?.agentPresence?.process || previous.connectionId !== null) &&
        identityOf()?.executionHost !== 'shared'
          ? previous
            ? endedPresenceOf(previous)
            : { agent: identityOf()?.status.agentType ?? 'unknown', ended: true }
          : undefined)
      if (endedPresence) {
        this.recordPaneAgentExit(paneKey, endedPresence, identityOf()?.status)
      }
      if (!this.hasLiveClaimsForPaneKey(resolvedPaneKey)) {
        untouched.push(resolvedPaneKey)
        continue
      }
      const resumeRow = options?.preserveResumeIdentity
        ? this.toRetainedProviderSessionRow(previous)
        : null
      const retained =
        resumeRow && endedPresence ? { ...resumeRow, agentPresence: endedPresence } : resumeRow
      clearPane(resolvedPaneKey)
      if (retained) {
        admitLegacyAgentStatus(
          this.state,
          'main-status-cleanup',
          retained,
          AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
        )
        this.scheduleStatusPersist()
        this.notifyStatusChangeListeners()
      }
      this.commitStatusRowMutation(previous, retained)
      cleared += 1
    }
    return { cleared, untouched }
  }

  dropStatusEntriesForRemovedWorktree(worktreeId: string, host?: ExecutionHostScope): void {
    const parsed = host === ALL_EXECUTION_HOSTS_SCOPE ? null : parseExecutionHostId(host ?? 'local')
    // Runtime hosts own separate status stores.
    if (host !== ALL_EXECUTION_HOSTS_SCOPE && (!parsed || parsed.kind === 'runtime')) {
      return
    }
    const ownedByRemoved = (claim: { connectionId: string | null; worktreeId?: string }): boolean =>
      Boolean(claim.worktreeId && worktreeIdsEqual(claim.worktreeId, worktreeId)) &&
      (!parsed ||
        (parsed.kind === 'ssh'
          ? claim.connectionId === parsed.targetId
          : isLocalHookConnectionId(claim.connectionId)))
    // The startup snapshot may outlive its replaced map entry; revoke only the removed owner.
    for (const commitment of this.hydratedAuthorityCommitments) {
      if (ownedByRemoved(commitment)) {
        this.revokedHydratedAuthorityCommitments.add(commitment)
      }
    }
    const paneKeys = new Set<string>()
    for (const claim of [
      ...this.state.lastStatusByPaneKey.values(),
      ...this.persistedAuthorityCommitmentsByPaneKey.values()
    ]) {
      if (ownedByRemoved(claim)) {
        paneKeys.add(claim.paneKey)
      }
    }
    for (const paneKey of paneKeys) {
      const row = this.state.lastStatusByPaneKey.get(paneKey)
      const commitment = this.persistedAuthorityCommitmentsByPaneKey.get(paneKey)
      if (row && ownedByRemoved(row) && commitment && !ownedByRemoved(commitment)) {
        // A tokenless repaint cannot prove a foreign launch exited; retain it behind its token fence.
        const observation = this.currentAuthorityObservations.get(paneKey)
        const deleted = this.deleteStatusEntry(paneKey, { preserveAuthority: true })
        clearPaneCacheState(this.state, paneKey)
        if (observation && !ownedByRemoved(observation)) {
          this.currentAuthorityObservations.set(paneKey, observation)
        }
        this.restartedStatusLaunchTokenHashByPaneKey.set(paneKey, {
          hash: commitment.launchTokenHash,
          allowRetainedOwner: true
        })
        this.observations.forget(paneKey)
        this.commitStatusRowMutation(deleted, undefined)
        this.scheduleStatusPersist()
        this.notifyStatusChangeListeners()
        this.emitPaneStatusCleared({ paneKey })
        continue
      }
      const occupant = row ?? commitment
      if (occupant && !ownedByRemoved(occupant)) {
        if (commitment && ownedByRemoved(commitment)) {
          this.persistedAuthorityCommitmentsByPaneKey.delete(paneKey)
          this.hydratedLaunchTokenHashByPaneKey.delete(paneKey)
          this.scheduleStatusPersist()
        }
        const observation = this.currentAuthorityObservations.get(paneKey)
        if (observation && ownedByRemoved(observation)) {
          this.currentAuthorityObservations.delete(paneKey)
        }
        continue
      }
      // Fence the pane; another host may still own the same tab ID.
      this.retirePaneAuthority(paneKey)
      if (row) {
        this.emitPaneStatusCleared({ paneKey })
      }
    }
  }

  clearStatusEntriesForConnection(connectionId: string): void {
    const normalizedConnectionId = connectionId.trim()
    if (normalizedConnectionId.length === 0) {
      return
    }
    const clearedAt = Math.max(
      Date.now(),
      (this.connectionTimestampWatermarkById.get(normalizedConnectionId) ?? -1) + 1
    )
    this.connectionTimestampWatermarkById.set(normalizedConnectionId, clearedAt)
    let statusChanged = false
    for (const [paneKey, rawEntry] of this.state.lastStatusByPaneKey) {
      const entry = rawEntry as EnrichedAgentHookEventPayload
      // Why: unstamped rows can't be attributed to one host; leave them for normal pane teardown.
      if (entry.paneSleep || entry.connectionId !== normalizedConnectionId) {
        continue
      }
      const deleted = this.deleteStatusEntry(paneKey, { preserveAuthority: true })
      if (deleted) {
        statusChanged = true
        this.commitStatusRowMutation(deleted, undefined)
        // A replacement remote process may reuse the pane; discard the lost owner's children.
        this.state.providerState.clearPane(paneKey)
        if (deleted.payload.agentType === 'codex') {
          this.state.codexSubagentRosterByPaneKey.delete(paneKey)
          this.state.codexLeadStateByPaneKey.delete(paneKey)
          this.state.codexAsyncQuestionsByPaneKey.delete(paneKey)
        } else if (deleted.payload.agentType === 'claude') {
          this.state.claudeSubagentRosterByPaneKey.delete(paneKey)
          this.state.claudeLeadStateByPaneKey.delete(paneKey)
          this.state.claudeRunningNonAgentTasksByPaneKey.delete(paneKey)
          this.state.claudeActiveSessionCronPaneKeys.delete(paneKey)
        }
      }
    }
    for (const [paneKey, evidence] of this.currentAuthorityObservations) {
      if (evidence.connectionId === normalizedConnectionId) {
        this.currentAuthorityObservations.delete(paneKey)
      }
    }
    if (statusChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
    // Send the cutoff even with no matched row; another host may have overwritten it.
    this.emitPaneStatusCleared({
      transient: true,
      connectionId: normalizedConnectionId,
      clearedAt
    })
  }

  protected deleteStatusEntry(
    paneKey: string,
    options?: { preserveAuthority?: boolean }
  ): EnrichedAgentHookEventPayload | null {
    const resolvedPaneKey = this.resolvePaneKeyAlias(paneKey)
    const existing = this.state.lastStatusByPaneKey.get(resolvedPaneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing) {
      return this.deleteTmuxSelectedStatus(resolvedPaneKey) ?? null
    }
    deleteLegacyAgentStatus(this.state, resolvedPaneKey)
    this.activeHookTurnCompletedAtByPaneKey.delete(resolvedPaneKey)
    if (!options?.preserveAuthority) {
      this.hydratedLaunchTokenHashByPaneKey.delete(resolvedPaneKey)
      this.persistedAuthorityCommitmentsByPaneKey.delete(resolvedPaneKey)
    }
    this.clearAssistantMessageRetry(resolvedPaneKey)
    this.clearTranscriptPoll(resolvedPaneKey)
    this.runtimeObservedStatusPaneKeys.delete(resolvedPaneKey)
    this.currentAuthorityObservations.delete(resolvedPaneKey)
    if (existing.payload.state === 'done') {
      this.promptSentDedupeByPaneKey.delete(resolvedPaneKey)
    }
    return existing
  }
}
