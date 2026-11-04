import { OrcaRuntimeWithPersistTerminalSurfaceRetirements } from './terminal-surface-retirements'
import {
  captureTerminalCloseRequest,
  type RendererTerminalClose,
  type TerminalSurfaceCloseOptions
} from '../terminal-surface-close'
import type { TerminalSurfaceCloseTarget } from '../../../shared/workspace-layout/terminal-surface-close-target'
import { captureAcknowledgedTerminalTabRetirement } from '../workspace-session-terminal-tab-retirement-identity'
import { closeLeafOrTab } from '../../persistence/terminal-topology/terminal-topology-commit'

export abstract class OrcaRuntimeWithTerminalSurfaceCloseOwner extends OrcaRuntimeWithPersistTerminalSurfaceRetirements {
  protected captureTerminalTabRetirement(worktreeId: string, tabId: string) {
    const originalHostId = this.getWorkspaceSessionHostIdForTab(worktreeId, tabId)
    return captureAcknowledgedTerminalTabRetirement(worktreeId, tabId, () => {
      const resolvedHostId = this.getWorkspaceSessionHostIdForTab(worktreeId, tabId)
      const resolvedSession = this.store?.getWorkspaceSession?.(resolvedHostId)
      // Emptying the last tab may reroute the worktree to its catalog host.
      const hostId = resolvedSession?.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)
        ? resolvedHostId
        : originalHostId
      return {
        hostId,
        session: this.store?.getWorkspaceSession?.(hostId) ?? null,
        snapshot: this.mobileSessionTabsByWorktree.get(worktreeId),
        incarnationOf: (ptyId) => this.ptysById.get(ptyId)?.incarnationId
      }
    })
  }

  /** Commit explicit-close membership removal durably in the owning host partition before callers publish and kill. */
  protected async closeTerminalSurface(
    worktreeId: string,
    target: TerminalSurfaceCloseTarget,
    options: TerminalSurfaceCloseOptions = {}
  ): Promise<string[] | null> {
    return this.prepareTerminalSurfaceClose(worktreeId, target, options)()
  }

  protected prepareTerminalSurfaceClose(
    worktreeId: string,
    target: TerminalSurfaceCloseTarget,
    options: TerminalSurfaceCloseOptions = {}
  ): () => Promise<string[] | null> {
    const store = this.store
    if (!store?.getWorkspaceSession || !store.setWorkspaceSession || !store.runDurableMutation) {
      throw new Error('workspace_session_unavailable')
    }
    const acknowledgeTabRetirement =
      target.kind === 'tab' && !options.closedByLayoutOwner
        ? this.captureTerminalTabRetirement(worktreeId, target.tabId)
        : null
    const originalHostIds = this.getWorkspaceSessionHostIdsForTab(worktreeId, target.tabId)
    const hostIds = () => [
      ...new Set([
        ...originalHostIds,
        ...this.getWorkspaceSessionHostIdsForTab(worktreeId, target.tabId)
      ])
    ]
    const request = captureTerminalCloseRequest(
      worktreeId,
      target,
      originalHostIds,
      { getWorkspaceSession: (hostId) => store.getWorkspaceSession!(hostId) },
      acknowledgeTabRetirement !== null
    )
    return async () => {
      let projectedPtyIds: string[] | null = null
      let completed = false
      const mutate = closeLeafOrTab({
        worktreeId,
        target,
        options,
        ...request,
        ownerMatches: () => !acknowledgeTabRetirement || acknowledgeTabRetirement().matches,
        hostIds,
        getSession: (hostId) => store.getWorkspaceSession!(hostId),
        setSession: (session, hostId) => store.setWorkspaceSession!(session, hostId),
        onClosed: (ptyIds) => {
          projectedPtyIds = ptyIds
        }
      })
      let refusal: Error | undefined
      try {
        refusal = await store.runDurableMutation(() => {
          const result = mutate()
          // Only a normally returned mutation with every owner write finished is completion.
          completed = result.value === undefined && projectedPtyIds !== null
          return result
        })
      } catch (error) {
        if (!completed) {
          throw error
        }
        // Applied closes stay dirty when their subsequent disk write fails.
        console.error('[runtime] failed to persist terminal close:', error)
      }
      if (refusal) {
        throw refusal
      }
      return projectedPtyIds
    }
  }

  /** The desktop renderer's close intent: it already guarded, removed and killed; this only reports. */
  async closeTerminalSurfaceFromRenderer({ worktreeId, target, reason }: RendererTerminalClose) {
    const options = { allowMissing: true, force: true, closedByLayoutOwner: true, reason }
    await this.closeTerminalSurface(worktreeId, target, options)
  }
}
