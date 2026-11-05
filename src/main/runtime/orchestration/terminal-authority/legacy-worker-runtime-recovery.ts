import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import type { LegacyWorkerTerminalRecoveryPlan } from '../orchestration-legacy-worker-terminal-recovery'
import type { LegacyWorkerTerminalRecoveryResult } from './structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import { RuntimeWorkspaceSessionFlush } from '../../workspaces/session-hosts/runtime-workspace-session-flush'

export abstract class LegacyWorkerRuntimeRecovery extends RuntimeWorkspaceSessionFlush {
  protected abstract getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>>

  protected abstract getLeafKey(tabId: string, leafId: string): string

  async reconcileLegacyWorkerTerminals(
    options: { connectionId?: string; materializeRenderer?: boolean } = {}
  ): Promise<LegacyWorkerTerminalRecoveryResult> {
    return this.legacyWorkerRecovery.reconcile(options)
  }

  stopLegacyWorkerTerminalRecovery(): Promise<void> {
    return this.legacyWorkerRecovery.stop()
  }

  protected updateLegacyWorkerTerminalRecoveryRetry(
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: { connectionId?: string; materializeRenderer?: boolean }
  ): void {
    this.legacyWorkerRecovery.updateRetry(plan, deferredDispatchIds, options)
  }

  async refreshRestoredOrchestrationAuthority(connectionId: string | null = null): Promise<void> {
    if (connectionId === null && !this.canRecoverPersistentLocalPtysFn()) {
      return
    }
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      [...(await this.getResolvedWorktreeMap()).values()],
      null,
      undefined,
      connectionId
    )
    if (!inventory) {
      throw new Error('terminal_liveness_unavailable')
    }
  }
}
