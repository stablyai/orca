import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

type RetainedCodexHookService = {
  install: (runtimeHomePath: string) => AgentHookInstallStatus | Promise<AgentHookInstallStatus>
  refreshRuntimeUserHooks: (
    runtimeHomePath: string
  ) => AgentHookInstallStatus | Promise<AgentHookInstallStatus>
}

/** Reconcile retained homes outside the startup critical path; each may run a slow trust grant. */
export async function reconcileRetainedCodexHookHomes(args: {
  hookService: RetainedCodexHookService
  hooksEnabled: boolean
  runtimeHomePaths: readonly string[]
}): Promise<void> {
  for (const runtimeHomePath of args.runtimeHomePaths) {
    try {
      const status = args.hooksEnabled
        ? await args.hookService.install(runtimeHomePath)
        : await args.hookService.refreshRuntimeUserHooks(runtimeHomePath)
      if (status.state === 'error') {
        console.warn('[codex-hook-service] failed to reconcile retained Codex home', status.detail)
      }
    } catch (error) {
      // A failed home repair must not prevent daemon availability.
      console.warn('[codex-hook-service] failed to reconcile retained Codex home', error)
    }
  }
}
