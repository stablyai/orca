import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

type RetainedCodexHookService = {
  install: (runtimeHomePath: string) => AgentHookInstallStatus | Promise<AgentHookInstallStatus>
  refreshRuntimeUserHooks: (
    runtimeHomePath: string
  ) => AgentHookInstallStatus | Promise<AgentHookInstallStatus>
}

/**
 * Repairs the hook state of Codex homes that retained shells still point at.
 *
 * Why not on the startup critical path (#16441): each home can run a codex
 * app-server trust-grant session, so N retained homes used to mean N sequential
 * multi-second blocks before the first window could paint. Callers start this
 * and move on — the repair only matters before a retained shell's next Codex
 * invocation, which cannot happen until the daemon provider is already serving.
 */
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
      // Why: a retained home repair is best-effort; daemon availability must not depend on a writable Codex config.
      console.warn('[codex-hook-service] failed to reconcile retained Codex home', error)
    }
  }
}
