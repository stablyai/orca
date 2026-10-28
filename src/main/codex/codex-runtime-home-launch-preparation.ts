import type { CodexHomeLaunchContext } from '../ipc/pty/host-env/types'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { codexHookService } from './hook-service'
import { getDefaultWslDistro } from '../wsl'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import { reconcileCodexHooksForLaunch } from './codex-hook-reconcile'
import { grantCodexSandboxReadOnManagedHome } from './codex-windows-sandbox-read-grant'

export function createCodexRuntimeHomeLaunchPreparation(deps: {
  getRuntimeHome: () => Pick<CodexRuntimeHomeService, 'prepareForCodexLaunchAsync'> | null
  getSettings: () => GlobalSettings | undefined
}) {
  return async (
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    launchContext?: CodexHomeLaunchContext
  ): Promise<string | null> => {
    const runtimeHome = deps.getRuntimeHome()
    if (!runtimeHome) {
      throw new Error('Codex runtime home service is not initialized')
    }
    // Propagate home failures: null selects the system account, which could launch the wrong identity (STA-4422).
    const runtimeHomePath = await runtimeHome.prepareForCodexLaunchAsync(target, launchEnv, {
      unavailableManagedHomePath: launchContext?.unavailableManagedHomePath
    })
    const launchesCodex = launchContext?.launchesCodex === true
    if (runtimeHomePath === null && target?.runtime !== 'wsl') {
      // Only terminal Codex launches wait for the scheduled hook reconciliation.
      if (launchesCodex) {
        await reconcileCodexHooksForLaunch()
      }
      return null
    }
    if (runtimeHomePath !== null && target?.runtime !== 'wsl') {
      await grantCodexSandboxReadOnManagedHome(runtimeHomePath)
    }
    const hookTarget =
      target?.runtime === 'wsl'
        ? { runtime: 'wsl' as const, wslDistro: target.wslDistro?.trim() || getDefaultWslDistro() }
        : target
    const isHooksEnabled = (): boolean =>
      isAgentStatusHooksEnabledForAgent(deps.getSettings(), 'codex')
    const hooksEnabled = isHooksEnabled()
    try {
      const status = await codexHookService.prepareRuntimeHomeForLaunch(
        runtimeHomePath,
        hookTarget,
        isHooksEnabled,
        launchesCodex
      )
      if (status.state === 'error') {
        console.warn(
          `[codex-hook-service] failed to ${hooksEnabled ? 'refresh' : 'refresh user'} runtime hooks before launch`,
          status.detail
        )
      }
    } catch (error) {
      // Malformed hooks must not prevent Codex from starting.
      console.warn(
        `[codex-hook-service] failed to ${hooksEnabled ? 'refresh' : 'refresh user'} runtime hooks before launch`,
        error
      )
    }
    return runtimeHomePath
  }
}
