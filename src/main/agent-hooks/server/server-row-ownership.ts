import { sameAgentStatusTerminalOwner } from '../../../shared/agent-status/identity/agent-status-terminal-owner'
import { structuralValuesEqualIgnoringUndefined } from '../../../shared/collections/structural-value-equality'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type {
  AgentHookStatusRowIdentity,
  AgentHookStatusRowMutation,
  EnrichedAgentHookEventPayload,
  StatusRowMutationListener
} from './server-types'
import { toAgentStatusIpcPayload } from './server-status-identity'
import { AgentHookServerListeners } from './server-listeners'

function toMutationIdentity(
  row: EnrichedAgentHookEventPayload | null | undefined
): AgentHookStatusRowIdentity | null {
  if (!row) {
    return null
  }
  return {
    paneKey: row.paneKey,
    ...(row.providerSession ? { providerSession: row.providerSession } : {}),
    ...(row.payload.agentType ? { agentType: row.payload.agentType } : {}),
    ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
    ...(row.terminalHandle ? { terminalHandle: row.terminalHandle } : {})
  }
}

function semanticRow(row: EnrichedAgentHookEventPayload): Record<string, unknown> {
  const {
    receivedAt: _receivedAt,
    evidenceObservedAt: _evidenceObservedAt,
    observation: _observation,
    launchToken: _launchToken,
    promptInteractionKey: _promptInteractionKey,
    ...semantic
  } = toAgentStatusIpcPayload(row)
  return semantic
}

// Per-write comparison skips shared leaves and exits early without serializing large messages.
function semanticRowChange(
  before: EnrichedAgentHookEventPayload | null | undefined,
  after: EnrichedAgentHookEventPayload | null | undefined
): 'none' | 'subagents' | 'row' {
  if (before === after || (!before && !after)) {
    return 'none'
  }
  if (!before || !after) {
    return 'row'
  }
  const previous = semanticRow(before)
  const next = semanticRow(after)
  if (before.payload.agentType === 'antigravity' && after.payload.agentType === 'antigravity') {
    const { subagents: previousChildren, ...previousLead } = previous
    const { subagents: nextChildren, ...nextLead } = next
    if (!structuralValuesEqualIgnoringUndefined(previousLead, nextLead)) {
      return 'row'
    }
    return structuralValuesEqualIgnoringUndefined(previousChildren, nextChildren)
      ? 'none'
      : 'subagents'
  }
  return structuralValuesEqualIgnoringUndefined(previous, next) ? 'none' : 'row'
}

export abstract class AgentHookServerRowOwnership extends AgentHookServerListeners {
  /** Set only for the direct applyNormalizedStatus call of applyRestatedStatus. */
  protected restatingStatus = false

  /** Orca's own restatement of a row (an inferred settle, a timer or poll republish) carries the
   *  row's evidence; only the agent's own events may name or replace the pane's owner. */
  protected applyRestatedStatus(
    incoming: AgentHookEventPayload
  ): EnrichedAgentHookEventPayload | undefined {
    if (
      incoming.payload.state === 'done' &&
      this.terminalPaneLifecycle?.isStopping(incoming.paneKey) &&
      this.state.lastStatusByPaneKey.get(incoming.paneKey)?.payload.state !== 'done'
    ) {
      return undefined
    }
    this.restatingStatus = true
    try {
      return this.applyNormalizedStatus(incoming)
    } finally {
      this.restatingStatus = false
    }
  }

  _resetRowOwnershipForTests(): void {
    this.paneKeyByTerminalHandle.clear()
    this.statusQueryIndex = null
  }

  subscribeStatusRowMutations(listener: StatusRowMutationListener): () => void {
    this.statusRowMutationListeners.add(listener)
    return () => {
      this.statusRowMutationListeners.delete(listener)
    }
  }

  protected getStatusPaneKeyForTerminalHandle(terminalHandle: string): string | undefined {
    return this.paneKeyByTerminalHandle.get(terminalHandle)
  }

  protected sameTerminalOwner(
    previous: Pick<AgentHookEventPayload, 'connectionId' | 'worktreeId'>,
    incoming: Pick<AgentHookEventPayload, 'connectionId' | 'worktreeId'>
  ): boolean {
    return sameAgentStatusTerminalOwner(previous, incoming)
  }

  protected retainedOwnerLaunchTokenHash(
    paneKey: string,
    incoming: Pick<AgentHookEventPayload, 'connectionId' | 'worktreeId'>
  ): string | undefined {
    const fence = this.restartedStatusLaunchTokenHashByPaneKey.get(paneKey)
    const authority = this.persistedAuthorityCommitmentsByPaneKey.get(paneKey)
    return fence?.allowRetainedOwner &&
      authority?.worktreeId &&
      incoming.worktreeId &&
      this.sameTerminalOwner(authority, incoming)
      ? authority.launchTokenHash
      : undefined
  }

  protected commitStatusRowMutation(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined,
    emit = true
  ): boolean {
    if (
      before?.terminalHandle &&
      this.paneKeyByTerminalHandle.get(before.terminalHandle) === before.paneKey
    ) {
      this.paneKeyByTerminalHandle.delete(before.terminalHandle)
    }
    if (after?.terminalHandle) {
      this.paneKeyByTerminalHandle.set(after.terminalHandle, after.paneKey)
    }
    for (const key of new Set([before?.paneKey, after?.paneKey])) {
      if (key) {
        this.updateStatusQueryIndex(key)
      }
    }
    const change = emit ? semanticRowChange(before, after) : 'none'
    if (change === 'none') {
      return false
    }
    this.notifyStatusRowMutationListeners({
      before: toMutationIdentity(before),
      after: toMutationIdentity(after),
      ...(change === 'subagents' ? { subagentsOnly: true as const } : {})
    })
    return true
  }

  /** Facet-only ticks reach row/window readers, without triggering enriched transition subscribers. */
  protected republishProgramStatusFacet(paneKey: string): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
    const row = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!row || row.providerSessionOnly === true) {
      return
    }
    this.onAgentStatus?.({ ...this.programStatusFacets.stitch(row), programStatusOnly: true })
    const identity = toMutationIdentity(row)
    this.notifyStatusRowMutationListeners({ before: identity, after: identity })
  }

  protected publishAgentIdentityProjection(row: EnrichedAgentHookEventPayload): void {
    // An id is no provider event: drop the row's last hook signals so no reader re-acts on them.
    const {
      hookEventName: _hookEventName,
      hasExplicitPrompt: _hasExplicitPrompt,
      promptInteractionKey: _promptInteractionKey,
      authorityRestartId: _authorityRestartId,
      ...projection
    } = row
    this.onAgentStatus?.({
      ...this.programStatusFacets.stitch(projection),
      isReplay: true,
      identityOnly: true
    })
    const identity = toMutationIdentity(row)
    this.notifyStatusRowMutationListeners({ before: identity, after: identity })
  }

  private notifyStatusRowMutationListeners(mutation: AgentHookStatusRowMutation): void {
    for (const listener of this.statusRowMutationListeners) {
      try {
        listener(mutation)
      } catch (error) {
        console.error('[agent-hooks] status-row mutation listener threw', error)
      }
    }
  }
}
