import type { BrowserWindow } from 'electron'
import { registerCoreHandlers } from '../ipc/register-core-handlers/register-core-handlers'
import { attachMainWindowServices } from '../window/attach-main-window-services'
import { initTccPromptNotice } from '../macos-tcc-prompt-notice'
import { resolveUpdateInstallMode } from '../updater'
import { mainProcessState as state } from './main-process-state'
import { prepareCodexAiVaultSessionResume } from '../codex/codex-ai-vault-session-resume'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { preserveAgentAuthBeforeRestart } from '../agent-auth-restart-preservation'
import {
  emitPluginWorktreeLifecycle,
  handleCodexHomePtySpawned,
  handlePtyExit
} from './main-process-pty-startup'
import { prepareCodexRuntimeHomeForLaunch } from './codex-launch-preparation'
import { prepareCodexSessionResumeForLaunch } from './codex-session-resume-launch'
import { isRecoveryReloadInFlight } from './main-window-lifecycle-flags'

export function attachMainWindowCoreServices(
  window: BrowserWindow,
  deps: {
    markExpectedRendererReload: (webContentsId: number) => void
    recordRendererReload: (ignoreCache: boolean) => void
  }
): void {
  const store = state.store
  const runtime = state.runtime
  const stats = state.stats
  const claudeUsage = state.claudeUsage
  const codexUsage = state.codexUsage
  const openCodeUsage = state.openCodeUsage
  const codexAccounts = state.codexAccounts
  const claudeAccounts = state.claudeAccounts
  const rateLimits = state.rateLimits
  const automations = state.automations
  const keybindings = state.keybindings
  const codexRuntimeHome = state.codexRuntimeHome
  const claudeRuntimeAuth = state.claudeRuntimeAuth
  if (
    !store ||
    !runtime ||
    !stats ||
    !claudeUsage ||
    !codexUsage ||
    !openCodeUsage ||
    !codexAccounts ||
    !claudeAccounts ||
    !rateLimits ||
    !automations ||
    !keybindings ||
    !codexRuntimeHome ||
    !claudeRuntimeAuth
  ) {
    throw new Error('Main window services must be initialized before attaching')
  }
  registerCoreHandlers(
    store,
    runtime,
    stats,
    claudeUsage,
    codexUsage,
    openCodeUsage,
    codexAccounts,
    claudeAccounts,
    rateLimits,
    window.webContents.id,
    automations,
    {
      prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
      prepareForClaudeLaunch: (target) => claudeRuntimeAuth.prepareForClaudeLaunch(target)
    },
    state.agentAwakeService ?? undefined,
    state.crashReports ?? undefined,
    keybindings,
    {
      getAdditionalAiVaultCodexHomePaths: () =>
        codexRuntimeHome.getHostCodexHomePathsForSessionDiscovery(),
      prepareAiVaultSessionResume: (args) =>
        prepareCodexAiVaultSessionResume(args, {
          runtimeHome: codexRuntimeHome,
          systemCodexHomePath: resolveHostCodexSessionSourceHome(store.getSettings())
        }),
      onBeforeRelaunch: async () => {
        state.isQuitting = true
        state.desktopRelayService?.fenceAndCloseNow()
        await preserveAgentAuthBeforeRestart({
          codexRuntimeHome,
          claudeRuntimeAuth,
          store
        })
      },
      onOrcaProfileAuthMutation: () => state.desktopRelayService?.authMutated(),
      onBeforeOrcaProfileSignOut: () => state.desktopRelayService?.fenceAndCloseNow()
    },
    state.pluginService ?? undefined,
    state.pluginMarketplaceService && state.pluginMarketplaceInstaller
      ? { marketplace: state.pluginMarketplaceService, installer: state.pluginMarketplaceInstaller }
      : undefined
  )
  automations.setWebContents(window.webContents)
  automations.start()
  attachMainWindowServices(
    window,
    store,
    runtime,
    prepareCodexRuntimeHomeForLaunch,
    (target) => claudeRuntimeAuth.prepareForClaudeLaunch(target),
    {
      prepareCodexSessionResume: prepareCodexSessionResumeForLaunch,
      awaitLocalPtyStartup: () => state.localPtyStartupReady,
      awaitLocalPtyProviderStartup: () => state.localPtyProviderStartupReady,
      onBeforeRendererReload: ({ ignoreCache, webContentsId }) => {
        if (window.webContents.id === webContentsId) {
          deps.markExpectedRendererReload(webContentsId)
        }
        deps.recordRendererReload(ignoreCache)
      },
      // Why: let the PTY layer skip its orphan sweep on the recovery reload that re-fires did-finish-load, so live local sessions survive (#5787).
      isRecoveryReloadInFlight,
      onCodexHomePtySpawned: handleCodexHomePtySpawned,
      onPtyExit: handlePtyExit,
      onBeforeUpdateQuit: () =>
        preserveAgentAuthBeforeRestart({ codexRuntimeHome, claudeRuntimeAuth, store }),
      updateInstallMode: resolveUpdateInstallMode(state.isServeMode),
      onWorktreeLifecycle: emitPluginWorktreeLifecycle
    }
  )
  // Why: attach the durable renderer pull now, but launch the diagnostic process after first paint.
  initTccPromptNotice(window, { deferWatchUntilReadyToShow: true })
  rateLimits.attach(window)
  // Why: quota probes spawn CLIs and hit network, so don't fetch immediately and compete with first paint; show/focus listeners refresh later.
  rateLimits.start({ fetchImmediately: false })
}
