import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

type RetainedCodexHookService = {
  install: (runtimeHomePath: string) => AgentHookInstallStatus
  refreshRuntimeUserHooks: (runtimeHomePath: string) => AgentHookInstallStatus
}

export function reconcileRetainedCodexHookHomes(args: {
  hookService: RetainedCodexHookService
  hooksEnabled: boolean
  runtimeHomePaths: readonly string[]
}): void {
  for (const runtimeHomePath of args.runtimeHomePaths) {
    try {
      const status = args.hooksEnabled
        ? args.hookService.install(runtimeHomePath)
        : args.hookService.refreshRuntimeUserHooks(runtimeHomePath)
      if (status.state === 'error') {
        console.warn('[codex-hook-service] failed to reconcile retained Codex home', status.detail)
      }
    } catch (error) {
      // Why: a retained home repair is best-effort; daemon availability must not depend on a writable Codex config.
      console.warn('[codex-hook-service] failed to reconcile retained Codex home', error)
    }
  }
}
