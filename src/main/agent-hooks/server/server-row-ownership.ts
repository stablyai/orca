import { sameAgentStatusTerminalOwner } from '../../../shared/agent-status-terminal-owner'
import { structuralValuesEqualIgnoringUndefined } from '../../../shared/structural-value-equality'
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

// Why: runs on every status write; a structural walk exits on the first difference and skips
// shared leaves (e.g. an unchanged 8 KB lastAssistantMessage) instead of serializing both rows.
function semanticRowsEqual(
  before: EnrichedAgentHookEventPayload | null | undefined,
  after: EnrichedAgentHookEventPayload | null | undefined
): boolean {
  if (before === after || (!before && !after)) {
    return true
  }
  if (!before || !after) {
    return false
  }
  return structuralValuesEqualIgnoringUndefined(semanticRow(before), semanticRow(after))
}

export abstract class AgentHookServerRowOwnership extends AgentHookServerListeners {
  _resetRowOwnershipForTests(): void {
    this.paneKeyByTerminalHandle.clear()
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
    if (!emit || semanticRowsEqual(before, after)) {
      return false
    }
    this.notifyStatusRowMutationListeners({
      before: toMutationIdentity(before),
      after: toMutationIdentity(after)
    })
    return true
  }

  /** Republish a row whose OSC 7501 facet alone changed, to the window and row-mutation readers only:
   *  enriched listeners (plugins, recorder, titles) must not see progress ticks as transitions. */
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
