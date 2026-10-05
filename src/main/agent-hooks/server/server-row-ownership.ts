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
import {
  isSameAgentProcess,
  type AgentProcessPresence
} from '../../../shared/agent-process-presence'
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

/** A pane's canonical owner changed (owner, process, ended or removed), whatever the IPC row did. */
export type AgentPresenceChange = {
  paneKey: string
  previous: AgentProcessPresence | undefined
  presence: AgentProcessPresence | undefined
}
export type AgentPresenceChangeListener = (change: AgentPresenceChange) => void

function samePresence(
  a: AgentProcessPresence | undefined,
  b: AgentProcessPresence | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.agent !== b.agent || a.ended !== b.ended) {
    return false
  }
  return a.process && b.process ? isSameAgentProcess(a.process, b.process) : a.process === b.process
}

export abstract class AgentHookServerRowOwnership extends AgentHookServerListeners {
  private readonly agentPresenceChangeListeners = new Set<AgentPresenceChangeListener>()

  _resetRowOwnershipForTests(): void {
    this.paneKeyByTerminalHandle.clear()
  }

  /** Host-only: owner/process/ended transitions, including ones the IPC projection omits. */
  subscribeAgentPresenceChanges(listener: AgentPresenceChangeListener): () => void {
    this.agentPresenceChangeListeners.add(listener)
    return () => {
      this.agentPresenceChangeListeners.delete(listener)
    }
  }

  /** Host-only read of a pane's canonical owner descriptor, ended owners included. */
  getAgentPresenceForPaneKey(paneKey: string): AgentProcessPresence | undefined {
    return this.state.lastStatusByPaneKey.get(this.resolvePaneKeyAlias(paneKey))?.agentPresence
  }

  protected notifyAgentPresenceChange(change: AgentPresenceChange): void {
    if (samePresence(change.previous, change.presence)) {
      return
    }
    for (const listener of this.agentPresenceChangeListeners) {
      try {
        listener(change)
      } catch (error) {
        console.error('[agent-hooks] agent presence listener threw', error)
      }
    }
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
    previous: EnrichedAgentHookEventPayload,
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
    const paneKey = after?.paneKey ?? before?.paneKey
    if (paneKey && before?.paneKey === after?.paneKey) {
      // Why before the IPC equality check: the projection omits agentPresence entirely.
      this.notifyAgentPresenceChange({
        paneKey,
        previous: before?.agentPresence,
        presence: after?.agentPresence
      })
    } else {
      for (const row of [before, after]) {
        if (row) {
          this.notifyAgentPresenceChange({
            paneKey: row.paneKey,
            previous: row === before ? row.agentPresence : undefined,
            presence: row === after ? row.agentPresence : undefined
          })
        }
      }
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
