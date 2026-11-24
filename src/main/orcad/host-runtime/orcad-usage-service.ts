import { join } from 'node:path'
import type { Store } from '../../persistence/loading-store/store'
import type { AutomationUsageClient } from '../../../shared/backend/backend-service-contract'
import type { AutomationRunUsage } from '../../../shared/automations/history/automation-run'
import type { BackendServiceCleanup } from '../../backend/service-composition'
import type { createUsageService } from '../../backend/usage-service'
import { claudeProfileTranscriptDirs } from '../../claude-usage/transcript-file-discovery'
import { provideHostUsageAnalytics } from '../../usage/host-usage-analytics'
import { UsageWorktreeHistory } from '../../usage/worktree-attribution/usage-worktree-history'
import { readUsageWorktreeCatalog } from '../../usage/worktree-attribution/usage-worktree-metadata'

export type OrcadUsageClients = {
  claudeUsage: AutomationUsageClient
  codexUsage: AutomationUsageClient
}

/** This host computes usage for its own transcripts; the service starts on first use, so idle hosts pay nothing. */
export function installOrcadUsageService(
  store: Store,
  userDataPath: string,
  registerCleanup: (cleanup: BackendServiceCleanup) => void
): OrcadUsageClients {
  // Built now so worktrees removed before the first usage read stay in the Orca scope.
  const worktrees = new UsageWorktreeHistory(
    store,
    join(userDataPath, 'orca-usage-worktree-history.json')
  )
  const abort = new AbortController()
  let service: Promise<ReturnType<typeof createUsageService>> | null = null
  const start = (): Promise<ReturnType<typeof createUsageService>> => {
    if (abort.signal.aborted) {
      return Promise.reject(
        new Error('Usage service is stopping. Try again after Orca reconnects.')
      )
    }
    if (service) {
      return service
    }
    const starting = import('../../backend/usage-service').then(({ createUsageService }) =>
      createUsageService({
        signal: abort.signal,
        userDataPath,
        readCatalog: () => readUsageWorktreeCatalog(worktrees),
        claudeProfileDirs: async () => claudeProfileTranscriptDirs(),
        // Product telemetry is reported by desktops, not by the hosts they pair with.
        telemetry: { isEnabled: async () => false, capture: async () => false }
      })
    )
    service = starting
    // A failed start must not stick; the next call tries again, as the desktop backend does.
    starting.catch(() => {
      if (service === starting) {
        service = null
      }
    })
    return starting
  }
  // Registered before RPC and automations start, so it stops after both (cleanups run in reverse).
  registerCleanup(async () => {
    abort.abort(new Error('Usage service is stopping.'))
    await (await service?.catch(() => null))?.stop()
    await worktrees.flush()
  })
  provideHostUsageAnalytics(async (call) => (await start()).invoke(call.method, call.params, false))
  const automationClient = (provider: keyof OrcadUsageClients): AutomationUsageClient => ({
    getAutomationRunUsage: async (input) => {
      const usage = await start()
      const method = `${provider}:getAutomationRunUsage`
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The usage service returns its typed automation result for this provider method.
      return (await usage.invoke(method, input, true)) as AutomationRunUsage
    }
  })
  return {
    claudeUsage: automationClient('claudeUsage'),
    codexUsage: automationClient('codexUsage')
  }
}
