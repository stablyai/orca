import { sessionIdFromStructuredWorkerIncarnation } from '../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import '../../rpc/methods/orchestration/structured-workers/orchestration-structured-worker-lifecycle'
import { observeStructuredWorker } from '../../orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import { OrcaRuntimeWithApplyMobileDisplayMode } from './terminal-display-mode'
import { addListenerToMap } from './terminal-listener-map'
import { notifyRuntimeListeners } from '../../events/runtime-listener-delivery'
import { withTimeoutResult } from '../../../../shared/concurrency/promise-timeout-fallback'

import { DEFAULT_TERMINAL_LIST_LIMIT } from '../query/terminal-list-limit'
import { PTY_CONTROLLER_LIST_TIMEOUT_MS } from '../lifecycle/pty-controller-inventory-budget'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult
} from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import {
  classifyIndexedWorkerTerminalProcessIncarnation,
  indexWorkerTerminalProcesses,
  type WorkerTerminalProcessIndex
} from '../../orchestration/terminal-authority/release/worker-terminal-process-liveness'
import { parseWorkerTerminalHostScope } from '../../../../shared/orchestration/workers/worker-terminal-host-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId
} from '../../../../shared/execution-host/execution-host'

export abstract class OrcaRuntimeWithSubscribeToTerminalResize extends OrcaRuntimeWithApplyMobileDisplayMode {
  subscribeToTerminalResize(
    ptyId: string,
    listener: (event: {
      cols: number
      rows: number
      displayMode: string
      reason: string
      seq?: number
    }) => void
  ): () => void {
    return addListenerToMap(this.resizeListeners, ptyId, listener)
  }

  protected notifyTerminalResize(
    ptyId: string,
    event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
  ): void {
    const listeners = this.resizeListeners.get(ptyId)
    if (!listeners) {
      return
    }
    notifyRuntimeListeners(listeners, (listener) => listener(event), 'pty-resize')
  }

  async listTerminals(
    worktreeSelector?: string,
    limit = DEFAULT_TERMINAL_LIST_LIMIT,
    opts: {
      handles?: readonly string[]
      requireFreshPtyLiveness?: boolean
      includeVisualLayouts?: boolean
    } = {}
  ): Promise<RuntimeTerminalListResult> {
    return this.terminalList.list(worktreeSelector, limit, opts)
  }

  /** `inventories`, shared across one sweep's calls, lists each host once instead of once per call. */
  async inspectTerminalProcessIncarnationLiveness(
    processIncarnation: string,
    serializedHostScope: string | null,
    inventories?: Map<string, Promise<WorkerTerminalProcessIndex | null>>
  ): Promise<'live' | 'exited' | 'unverifiable'> {
    const structuredSessionId = sessionIdFromStructuredWorkerIncarnation(processIncarnation)
    if (structuredSessionId) {
      // Structured sessions have no PTY; consult durable records through /clear successors. The in-memory registry vanishes at settlement, so absence there proves no exit.
      return observeStructuredWorker({ sessionId: structuredSessionId }).status
    }
    const hostScope = parseWorkerTerminalHostScope(serializedHostScope)
    const controller = this.ptyController
    if (!hostScope || !controller?.listProcesses) {
      return 'unverifiable'
    }
    const hostId =
      hostScope.kind === 'ssh' ? toSshExecutionHostId(hostScope.targetId) : LOCAL_EXECUTION_HOST_ID
    let listing = inventories?.get(hostId)
    if (!listing) {
      listing = withTimeoutResult(
        controller.listProcesses(hostId),
        PTY_CONTROLLER_LIST_TIMEOUT_MS
      ).then((listed) => (listed.ok ? indexWorkerTerminalProcesses(listed.value) : null))
      inventories?.set(hostId, listing)
    }
    const index = await listing
    return index
      ? classifyIndexedWorkerTerminalProcessIncarnation(processIncarnation, index)
      : 'unverifiable'
  }

  protected getTerminalTopologyRevision(worktreeId: string): number {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    return (
      this.getWorkspaceSessionForWorktree(worktreeId)?.terminalTopologyRevisionByRepoId?.[repoId] ??
      this.terminalTopologyRevisionByRepoId.get(repoId) ??
      0
    )
  }

  async adoptTerminalOrphans(
    request: RuntimeTerminalOrphanAdoptionRequest
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    if (request.claims.length === 0) {
      throw new Error('terminal_orphan_claims_required')
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
    return this.runWorktreeTerminalMutation(workspace.id, async () => {
      const resolvedWorkspace = workspace.folderWorkspace
        ? this.folderWorkspaceToResolvedWorktree(workspace.folderWorkspace)
        : await this.resolveGitWorktreeSelector(`id:${workspace.id}`)
      const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
        [resolvedWorkspace],
        workspace.id,
        undefined,
        workspace.connectionId ?? null
      )
      if (!inventory) {
        throw new Error('terminal_liveness_unavailable')
      }
      return this.adoptTerminalOrphansFromInventoryUnderMutation(request, workspace, inventory)
    })
  }
}
