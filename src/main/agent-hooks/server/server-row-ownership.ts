import {
  isWslHookRelayConnectionId,
  wslHookRelayConnectionId
} from '../../../shared/wsl-hook-relay-contract'
import { splitWorktreeIdForFilesystem, worktreeIdsEqual } from '../../../shared/worktree/id'
import { parseWslUncPath } from '../../../shared/wsl-paths'
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

function wslDistroForWorktree(worktreeId: string | undefined): string | null {
  const worktreePath = worktreeId
    ? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    : undefined
  return worktreePath ? (parseWslUncPath(worktreePath)?.distro ?? null) : null
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
    if (
      previous.worktreeId &&
      incoming.worktreeId &&
      !worktreeIdsEqual(previous.worktreeId, incoming.worktreeId)
    ) {
      return false
    }
    if (previous.connectionId === incoming.connectionId) {
      return true
    }
    const relayConnection = isWslHookRelayConnectionId(previous.connectionId)
      ? previous.connectionId
      : isWslHookRelayConnectionId(incoming.connectionId)
        ? incoming.connectionId
        : null
    const localConnection = previous.connectionId === null || incoming.connectionId === null
    if (!relayConnection || !localConnection || !previous.worktreeId || !incoming.worktreeId) {
      return false
    }
    const previousDistro = wslDistroForWorktree(previous.worktreeId)
    const incomingDistro = wslDistroForWorktree(incoming.worktreeId)
    return (
      previousDistro !== null &&
      incomingDistro !== null &&
      previousDistro === incomingDistro &&
      relayConnection === wslHookRelayConnectionId(previousDistro) &&
      worktreeIdsEqual(previous.worktreeId, incoming.worktreeId)
    )
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
    const mutation: AgentHookStatusRowMutation = {
      before: toMutationIdentity(before),
      after: toMutationIdentity(after)
    }
    for (const listener of this.statusRowMutationListeners) {
      try {
        listener(mutation)
      } catch (error) {
        console.error('[agent-hooks] status-row mutation listener threw', error)
      }
    }
    return true
  }
}
