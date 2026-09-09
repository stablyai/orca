import { app } from 'electron'
import type { CodexHomeLaunchContext } from '../ipc/pty'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import { markCodexProjectTrusted } from '../agent-trust-presets'
import { codexHookService } from '../codex/hook-service'
import { getDefaultWslDistro } from '../wsl'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
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
  if (
    target?.runtime !== 'wsl' &&
    launchContext?.launchAgent === 'codex' &&
    launchContext.workspacePath
  ) {
    try {
      // Why: renderer quick-launch cannot await trust IPC before its PTY mounts; launch prep runs before every recognized Codex spawn.
      await markCodexProjectTrusted(launchContext.workspacePath)
    } catch (error) {
      console.warn('[codex-project-trust] failed to pre-mark launch workspace:', error)
    }
  }
  const ensureRealHomeHooksIfSelected = async (): Promise<boolean> => {
    if (target?.runtime === 'wsl' || !runtimeHome.isHostSystemDefaultRealHomeSelected(launchEnv)) {
      return false
    }
    // Why (flag ON, system default): the hook entry must exist — appended last
    // and trusted by codex's own app-server grant — in the real ~/.codex before
    // the pane spawns. An incapable grant flips the lane gate so the launch
    // below falls back to the managed home instead of a status-blind pane.
    await ensureRealHomeCodexHookState({
      hooksEnabled: isAgentStatusHooksEnabled(state.store?.getSettings()),
      userDataPath: app.getPath('userData')
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
  const hooksEnabled = isAgentStatusHooksEnabled(state.store?.getSettings())
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
