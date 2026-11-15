import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import type { LegacyWorkerTerminalRecoveryPlan } from './release/orchestration-legacy-worker-terminal-recovery'
import type { LegacyWorkerTerminalRecoveryResult } from './structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import { RuntimeWorkspaceSessionFlush } from '../../workspaces/session-hosts/runtime-workspace-session-flush'
import { StartupWorkerAuthorityRestore } from './startup-worker-authority-restore'
import type { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport as StructuredSessionStartup } from '../../session-tabs/structured-session-create-support'

export abstract class LegacyWorkerRuntimeRecovery extends RuntimeWorkspaceSessionFlush {
  protected abstract getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>>
  readonly startupWorkerAuthority = new StartupWorkerAuthorityRestore()
  abstract prepareStructuredAgentSessionStartupRestoration(
    ...args: Parameters<StructuredSessionStartup['prepareStructuredAgentSessionStartupRestoration']>
  ): ReturnType<StructuredSessionStartup['prepareStructuredAgentSessionStartupRestoration']>

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
    if (connectionId === null) {
      // Why: until restart leases are reconciled, a chat worker that died with the last run reads as unverifiable.
      await this.prepareStructuredAgentSessionStartupRestoration().catch((error: unknown) => {
        console.warn('[orchestration] chat worker restart reconcile failed', error)
      })
      if (!this.canRecoverPersistentLocalPtysFn()) {
        return
      }
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
