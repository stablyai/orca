import type { CodexHomeLaunchContext } from '../ipc/pty'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import { codexHookService } from '../codex/hook-service'
import { getDefaultWslDistro } from '../wsl'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import { reconcileCodexHooksForLaunch } from '../codex/codex-hook-reconcile'
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
  // Why: a ManagedCodexHomeTemporarilyUnavailableError must escape uncaught —
  // the fallbacks below all key off `null`, which means "system default", so
  // swallowing the refusal would launch the wrong account (#STA-4422).
  const runtimeHomePath = await runtimeHome.prepareForCodexLaunchAsync(target, launchEnv, {
    unavailableManagedHomePath: launchContext?.unavailableManagedHomePath
  })
  const launchesCodex = launchContext?.launchesCodex === true
  if (runtimeHomePath === null && target?.runtime !== 'wsl') {
    // Why only a Codex launch waits: the pane spawn already schedules the reconcile, which
    // writes only on a change; plain terminals and structured launches never wait on it.
    if (launchesCodex) {
      await reconcileCodexHooksForLaunch()
    }
    return null
  }
  const hookTarget =
    target?.runtime === 'wsl'
      ? { runtime: 'wsl' as const, wslDistro: target.wslDistro?.trim() || getDefaultWslDistro() }
      : target
  const isHooksEnabled = (): boolean =>
    isAgentStatusHooksEnabledForAgent(state.store?.getSettings(), 'codex')
  const hooksEnabled = isHooksEnabled()
  try {
    // Why: honor the persisted off switch so post-startup launches can't reinstall removed hooks.
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
    // Why: hook install is best-effort launch prep; a malformed hooks file must not block Codex from starting.
    console.warn(
      `[codex-hook-service] failed to ${hooksEnabled ? 'refresh' : 'refresh user'} runtime hooks before launch`,
      error
    )
  }
  return runtimeHomePath
}
