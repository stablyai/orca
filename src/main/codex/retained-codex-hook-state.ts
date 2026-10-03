import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

type RetainedCodexHookService = {
  refreshRuntimeUserHooks: (
    runtimeHomePath: string
  ) => AgentHookInstallStatus | Promise<AgentHookInstallStatus>
}

/** Repairs the user-hook mirror of Codex homes that retained shells still point at. */
export async function reconcileRetainedCodexHookHomes(args: {
  hookService: RetainedCodexHookService
  runtimeHomePaths: readonly string[]
}): Promise<void> {
  for (const runtimeHomePath of args.runtimeHomePaths) {
    try {
      // Why refresh either way: Orca's hook rides each launch as a session flag, so a
      // retained home only mirrors the user's own hooks. A shell an older build
      // started carries no flag, so it shows no Codex status until reopened.
      const status = await args.hookService.refreshRuntimeUserHooks(runtimeHomePath)
      if (status.state === 'error') {
        console.warn('[codex-hook-service] failed to reconcile retained Codex home', status.detail)
      }
    } catch (error) {
      // Why: a retained home repair is best-effort; daemon availability must not depend on a writable Codex config.
      console.warn('[codex-hook-service] failed to reconcile retained Codex home', error)
    }
  }
}
