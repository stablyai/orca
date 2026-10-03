import type { CodexHomeLaunchContext } from '../ipc/pty'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import { codexHookService } from '../codex/hook-service'
import { getDefaultWslDistro } from '../wsl'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import { mainProcessState as state } from './main-process-state'

export async function prepareCodexRuntimeHomeForLaunch(
  target?: CodexAccountSelectionTarget,
  launchEnv?: NodeJS.ProcessEnv,
  launchContext?: CodexHomeLaunchContext
): Promise<string | null> {
  const runtimeHome = state.codexRuntimeHome
  if (!runtimeHome) {
    throw new Error('Codex runtime home service is not initialized')
  }
  // Why nothing for ~/.codex: Orca's status hook rides each launch as a session
  // flag, so launch prep only reads the user's real home.
  const runtimeHomePath = await runtimeHome.prepareForCodexLaunchAsync(target, launchEnv, {
    unavailableManagedHomePath: launchContext?.unavailableManagedHomePath
  })
  if (runtimeHomePath === null && target?.runtime !== 'wsl') {
    // Why: Codex runs on the user's real ~/.codex; the managed-home hook
    // install below would target a home Codex never reads on this lane.
    return null
  }
  const hookTarget =
    target?.runtime === 'wsl'
      ? { runtime: 'wsl' as const, wslDistro: target.wslDistro?.trim() || getDefaultWslDistro() }
      : target
  const hooksEnabled = isAgentStatusHooksEnabledForAgent(state.store?.getSettings(), 'codex')
  try {
    // Why: honor the persisted off switch so post-startup launches can't reinstall removed hooks.
    const status = await codexHookService.prepareRuntimeHomeForLaunch(
      runtimeHomePath,
      hookTarget,
      hooksEnabled
    )
    if (status.state === 'error') {
      console.warn(
        `[codex-hook-service] failed to ${hooksEnabled ? 'refresh' : 'refresh user'} runtime hooks before launch`,
        status.detail
      )
    }
  } catch (error) {
    // Why: hook install is best-effort launch prep; a malformed hooks file must not block Codex from starting.
    console.warn(
      `[codex-hook-service] failed to ${hooksEnabled ? 'refresh' : 'refresh user'} runtime hooks before launch`,
      error
    )
  }
  return runtimeHomePath
}
