// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateTerminal } from './orca-runtime-create-terminal'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../shared/runtime-types'
import { navigationTargetsHost } from '../../shared/runtime-navigation'
import { MOBILE_TERMINAL_CREATE_RESULT_TTL_MS } from './orca-runtime-core'

export class OrcaRuntimeWithCreateMobileSessionTerminal extends OrcaRuntimeWithCreateTerminal {
  async createMobileSessionTerminal(
    worktreeSelector: string,
    opts: {
      afterTabId?: string
      targetGroupId?: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      select?: boolean
      clientNavigationId?: string
      navigation?: RuntimeNavigationTarget
      clientMutationId?: string
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const navigation = opts.navigation ?? 'all'
    const select = opts.select ?? opts.activate !== false
    const runOpts = {
      ...opts,
      activate: select && navigationTargetsHost(navigation)
    }
    const mutationId = opts.clientMutationId
    let result: RuntimeMobileSessionCreateTerminalResult
    if (!mutationId) {
      result = await this.runCreateMobileSessionTerminal(worktreeSelector, runOpts)
    } else {
      // Why: idempotency is caller-owned; two paired devices may reuse the same mutation id without sharing a result.
      const mutationKey = `${opts.clientNavigationId ?? 'local'}\0${worktreeSelector}\0${mutationId}`
      // Why: a retried create (double-tap, reconnect replay) with the same
      // idempotency key must return the in-flight operation instead of spawning a
      // duplicate terminal. Successes are kept briefly so a retry whose response
      // was lost in transit reuses the created terminal; failures are dropped
      // immediately so a retry can start a fresh create.
      const inflight = this.mobileTerminalCreateByMutationId.get(mutationKey)
      const run = inflight ?? this.runCreateMobileSessionTerminal(worktreeSelector, runOpts)
      if (!inflight) {
        this.mobileTerminalCreateByMutationId.set(mutationKey, run)
        const drop = (): void => {
          if (this.mobileTerminalCreateByMutationId.get(mutationKey) === run) {
            this.mobileTerminalCreateByMutationId.delete(mutationKey)
          }
        }
        void run.then(() => {
          setTimeout(drop, MOBILE_TERMINAL_CREATE_RESULT_TTL_MS).unref?.()
        }, drop)
      }
      result = await run
    }
    if (select) {
      const worktreeId =
        this.getValidatedExplicitWorktreeIdSelector(worktreeSelector) ??
        (await this.resolveWorktreeSelector(worktreeSelector)).id
      this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        result.tab.id,
        navigation,
        opts.clientNavigationId
      )
    }
    return result
  }
}
