import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

type RetainedCodexHookService = {
  install: (runtimeHomePath: string) => Promise<AgentHookInstallStatus> | AgentHookInstallStatus
  refreshRuntimeUserHooks: (
    runtimeHomePath: string
  ) => Promise<AgentHookInstallStatus> | AgentHookInstallStatus
}

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
