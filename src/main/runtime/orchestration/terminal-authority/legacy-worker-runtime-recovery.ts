import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import type { LegacyWorkerTerminalRecoveryPlan } from './release/orchestration-legacy-worker-terminal-recovery'
import type { LegacyWorkerTerminalRecoveryResult } from './structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import { RuntimeWorkspaceSessionFlush } from '../../workspaces/session-hosts/runtime-workspace-session-flush'
import { StartupWorkerAuthorityRestore } from './startup-worker-authority-restore'
import type { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport as StructuredSessionStartup } from '../../session-tabs/chat/structured-session-create-support'
import {
  StructuredAgentSessionLaunchContinuationOnce,
  structuredAgentSessionLaunchContinuationDeps
} from '../../agent-session/lifecycle/structured-agent-session-launch-continuation'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

export abstract class LegacyWorkerRuntimeRecovery extends RuntimeWorkspaceSessionFlush {
  protected abstract getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>>
  readonly startupWorkerAuthority = new StartupWorkerAuthorityRestore()
  /** Settles once this start has continued (or offered) what the last run cut off. */
  readonly structuredAgentSessionLaunchContinuation =
    new StructuredAgentSessionLaunchContinuationOnce()
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
      // Off the startup path: continuations start providers and wait for their answers.
      this.structuredAgentSessionLaunchContinuation.start(
        structuredAgentSessionLaunchContinuationDeps(
          getStructuredAgentSessionHost(),
          () => this.store?.getSettings?.()?.nativeChatResumeWorkOnRestart === true
        )
      )
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
