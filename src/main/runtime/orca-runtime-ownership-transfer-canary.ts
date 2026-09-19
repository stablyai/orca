import { OrcaRuntimeWithOwnershipTransferExecution } from './orca-runtime-ownership-transfer-execution'
import type { PtyOwnershipTransferExecuteResult } from '../../shared/pty-ownership-transfer-orchestration'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../shared/workspace-scope'

export class OrcaRuntimeWithOwnershipTransferCanary extends OrcaRuntimeWithOwnershipTransferExecution {
  async transferCanaryDirectSshPtysForConnection(
    connectionId: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<readonly PtyOwnershipTransferExecuteResult[]> {
    if (!connectionId || !this.ptyOwnershipTransferMutationEnabled()) {
      return Object.freeze([])
    }
    const destination = this.getPtyOwnershipTransferDestinationRegistry()
    if (!destination) {
      return Object.freeze([])
    }
    const protectedSources = new Set<string>()
    const protectedSurfaces = new Set<string>()
    for (const candidate of destination.listRecoveryCandidates()) {
      protectedSources.add(`${candidate.journal.terminalId}\0${candidate.journal.incarnationId}`)
      if (candidate.surfaceBinding) {
        protectedSurfaces.add(candidate.surfaceBinding.ptyId)
      }
    }
    const candidates = [...this.ptysById.values()]
      .filter(
        (pty) =>
          pty.connectionId === connectionId &&
          pty.connected &&
          pty.incarnationId !== null &&
          parsePaneKey(pty.paneKey ?? '') !== null
      )
      .sort((left, right) => left.ptyId.localeCompare(right.ptyId))
    const transferred: PtyOwnershipTransferExecuteResult[] = []
    for (const candidate of candidates) {
      if (!this.ptyOwnershipTransferMutationEnabled()) {
        break
      }
      const current = this.ptysById.get(candidate.ptyId)
      const pane = parsePaneKey(candidate.paneKey ?? '')
      const parsed = parseAppSshPtyId(candidate.ptyId)
      if (
        current !== candidate ||
        !candidate.incarnationId ||
        !pane ||
        !parsed ||
        parsed.connectionId !== connectionId ||
        protectedSurfaces.has(candidate.ptyId) ||
        protectedSources.has(`${parsed.relayPtyId}\0${candidate.incarnationId}`)
      ) {
        continue
      }
      const parsedWorkspace = parseWorkspaceKey(candidate.worktreeId)
      const workspaceKey = parsedWorkspace
        ? parsedWorkspace.type === 'folder'
          ? folderWorkspaceKey(parsedWorkspace.folderWorkspaceId)
          : worktreeWorkspaceKey(parsedWorkspace.worktreeId)
        : this.store
              ?.getFolderWorkspaces?.()
              .some((workspace) => workspace.id === candidate.worktreeId)
          ? folderWorkspaceKey(candidate.worktreeId)
          : worktreeWorkspaceKey(candidate.worktreeId)
      const result = await this.transferPtyOwnership(
        {
          connectionId,
          ptyId: candidate.ptyId,
          destinationRuntimeId: this.runtimeId,
          surfaceBinding: {
            executionHostId: toSshExecutionHostId(connectionId),
            workspaceKey,
            tabId: pane.tabId,
            leafId: pane.leafId,
            ptyId: candidate.ptyId
          },
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
        },
        options.signal === undefined ? undefined : { signal: options.signal }
      )
      transferred.push(result)
      protectedSources.add(`${parsed.relayPtyId}\0${candidate.incarnationId}`)
      protectedSurfaces.add(candidate.ptyId)
    }
    return Object.freeze(transferred)
  }
}
