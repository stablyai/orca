import { app } from 'electron'
import type { CodexHomeLaunchContext } from '../ipc/pty'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import { codexHookService } from '../codex/hook-service'
import { getDefaultWslDistro } from '../wsl'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import { ensureRealHomeCodexHookState } from '../codex/codex-real-home-hook-install'
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
  const ensureRealHomeHooksIfSelected = async (): Promise<boolean> => {
    if (target?.runtime === 'wsl' || !runtimeHome.isHostSystemDefaultRealHomeSelected(launchEnv)) {
      return false
    }
    // Why (flag ON, system default): the hook entry must exist, appended last, in
    // the real ~/.codex before the pane spawns. This never waits on Codex's
    // approval: until it lands, the lane gate sends the launch below to the
    // managed home instead of a pane that would ask the user to review it.
    // Add-only: another build's entry is left for app start to convert.
    await ensureRealHomeCodexHookState({
      hooksEnabled: isAgentStatusHooksEnabledForAgent(state.store?.getSettings(), 'codex'),
      userDataPath: app.getPath('userData'),
      writePolicy: 'add-missing-only'
    })
    return true
  }
  let realHomeHooksPrepared = await ensureRealHomeHooksIfSelected()
  // Why: a ManagedCodexHomeTemporarilyUnavailableError must escape uncaught —
  // the fallbacks below all key off `null`, which means "system default", so
  // swallowing the refusal would launch the wrong account (#STA-4422).
  let runtimeHomePath = await runtimeHome.prepareForCodexLaunchAsync(target, launchEnv, {
    unavailableManagedHomePath: launchContext?.unavailableManagedHomePath
  })
  if (runtimeHomePath === null && !realHomeHooksPrepared) {
    // Why: launch prep can reject an untrusted managed home and clear its
    // selection. Establish hook capability for that newly selected lane, then
    // re-resolve if the capability gate rejects it.
    realHomeHooksPrepared = await ensureRealHomeHooksIfSelected()
    if (realHomeHooksPrepared) {
      runtimeHomePath = await runtimeHome.prepareForCodexLaunchAsync(target, launchEnv, {
        unavailableManagedHomePath: launchContext?.unavailableManagedHomePath
      })
    }
  }
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
