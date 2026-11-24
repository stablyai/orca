import type { BrowserWindow } from 'electron'
import { registerCoreHandlers } from '../../ipc/register-core-handlers/register-core-handlers'
import { attachMainWindowServices } from '../../window/attach-main-window-services'
import { initTccPromptNotice } from '../../macos-permissions/macos-tcc-prompt-notice'
import { resolveUpdateInstallMode } from '../../updater/updater-service'
import { fenceMainProcessCloudOnQuit } from '../cloud-startup/main-process-connector-startup'
import { mainProcessState as state } from '../main-process-state'
import { prepareCodexAiVaultSessionResume } from '../../codex/history/resume/codex-ai-vault-session-resume'
import { resolveHostCodexSessionSourceHome } from '../../codex/history/rollouts/codex-session-source-home'
import { preserveAgentAuthBeforeRestart } from '../../providers/accounts/agent-auth-restart-preservation'
import { preserveStateBeforeUpdateRestart } from '../../core-desktop/update-restart-preservation'
import {
  emitPluginWorktreeLifecycle,
  handleCodexHomePtySpawned,
  handlePtyExit
} from '../pty-startup/main-process-pty-startup'
import { prepareCodexRuntimeHomeForLaunch } from '../agent-accounts/codex-launch-preparation'
import { resolveHostAgentBaseEnvironment } from '../../runtime/agent-session/environment/structured-agent-shell-environment'
import {
  prepareCodexPinnedLaunchHome,
  prepareCodexSessionResumeForLaunch
} from '../agent-accounts/codex-session-resume-launch'
import { isRecoveryReloadInFlight } from './main-window-lifecycle-flags'
import { quitFromUserCommand } from './main-window-actions'

let attachmentTail: Promise<void> = Promise.resolve()

export function attachMainWindowCoreServices(
  window: BrowserWindow,
  deps: {
    hostInitialization: Promise<void>
    markExpectedRendererReload: (webContentsId: number) => void
    recordRendererReload: (ignoreCache: boolean) => void
  }
): Promise<void> {
  const attachment = attachmentTail.then(() => installMainWindowCoreServices(window, deps))
  attachmentTail = attachment.catch(() => {})
  return attachment
}

async function installMainWindowCoreServices(
  window: BrowserWindow,
  deps: {
    hostInitialization: Promise<void>
    markExpectedRendererReload: (webContentsId: number) => void
    recordRendererReload: (ignoreCache: boolean) => void
  }
): Promise<void> {
  if (window.isDestroyed() || state.mainWindow !== window || state.isQuitting) {
    throw new Error('Main window closed while preparing services')
  }
  const store = state.store
  const nativeSettings = state.nativeSettings
  const runtime = state.core.runtime
  const stats = state.core.stats
  const codexAccounts = state.core.codexAccounts
  const claudeAccounts = state.core.claudeAccounts
  const rateLimits = state.core.rateLimits
  const automations = state.core.automations
  const keybindings = state.core.keybindings
  const codexRuntimeHome = state.core.codexRuntimeHome
  const claudeRuntimeAuth = state.core.claudeRuntimeAuth
  const orcaAccount = state.core.orcaAccount
  if (
    !store ||
    !nativeSettings ||
    !runtime ||
    !stats ||
    !codexAccounts ||
    !claudeAccounts ||
    !rateLimits ||
    !automations ||
    !keybindings ||
    !codexRuntimeHome ||
    !claudeRuntimeAuth ||
    !orcaAccount
  ) {
    throw new Error('Main window services must be initialized before attaching')
  }
  await registerCoreHandlers(
    store,
    runtime,
    stats,
    codexAccounts,
    claudeAccounts,
    rateLimits,
    window.webContents.id,
    automations,
    {
      prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
      prepareForClaudeLaunch: (target) => claudeRuntimeAuth.prepareForClaudeLaunch(target),
      resolveBaseEnvironment: () => resolveHostAgentBaseEnvironment(store.getSettings())
    },
    state.agentAwakeService ?? undefined,
    state.crashReports ?? undefined,
    keybindings,
    {
      deferHostInitialization: true,
      hostInitialization: deps.hostInitialization,
      settingsFile: state.settingsFile,
      getAdditionalAiVaultCodexHomePaths: () =>
        codexRuntimeHome.getHostCodexHomePathsForSessionDiscovery(),
      prepareAiVaultSessionResume: (args) =>
        prepareCodexAiVaultSessionResume(args, {
          runtimeHome: codexRuntimeHome,
          systemCodexHomePath: resolveHostCodexSessionSourceHome(store.getSettings()),
          preparePinnedLaunchHome: (home) => prepareCodexPinnedLaunchHome(home)
        }),
      onBeforeRelaunch: async () => {
        state.isQuitting = true
        fenceMainProcessCloudOnQuit()
        await preserveAgentAuthBeforeRestart({ codexRuntimeHome, store })
      },
      onQuit: quitFromUserCommand,
      orcaAccount,
      rendererCheckpoint: state.core.rendererCheckpoint ?? undefined
    },
    state.core.pluginService ?? undefined,
    state.core.pluginMarketplaceService && state.core.pluginMarketplaceInstaller
      ? {
          marketplace: state.core.pluginMarketplaceService,
          installer: state.core.pluginMarketplaceInstaller,
          ...(state.core.pluginAutoUpdater ? { autoUpdater: state.core.pluginAutoUpdater } : {}),
          ...(state.core.pluginInstallStatsService
            ? { installStats: state.core.pluginInstallStatsService }
            : {}),
          ...(state.core.pluginUpdateReviewNotices
            ? { reviewNotices: state.core.pluginUpdateReviewNotices }
            : {})
        }
      : undefined
  )
  if (window.isDestroyed() || state.mainWindow !== window || state.isQuitting) {
    throw new Error('Main window closed while preparing services')
  }
  automations.start()
  await attachMainWindowServices(
    window,
    store,
    nativeSettings,
    runtime,
    prepareCodexRuntimeHomeForLaunch,
    (target) => claudeRuntimeAuth.prepareForClaudeLaunch(target),
    {
      prepareCodexSessionResume: prepareCodexSessionResumeForLaunch,
      deferSshInitialization: true,
      hostInitialization: deps.hostInitialization,
      awaitLocalPtyStartup: () => state.localPtyStartupReady,
      awaitLocalPtyProviderStartup: () => state.localPtyProviderStartupReady,
      onBeforeRendererReload: ({ ignoreCache, webContentsId }) => {
        if (window.webContents.id === webContentsId) {
          deps.markExpectedRendererReload(webContentsId)
        }
        deps.recordRendererReload(ignoreCache)
      },
      // Recovery did-finish-load must skip orphan sweeping to preserve live PTYs (#5787).
      isRecoveryReloadInFlight,
      onCodexHomePtySpawned: handleCodexHomePtySpawned,
      onPtyExit: handlePtyExit,
      onBeforeUpdateQuit: () => preserveStateBeforeUpdateRestart({ codexRuntimeHome, store }),
      onBeforeUpdateQuitFailure: 'abort',
      updateInstallMode: resolveUpdateInstallMode(state.isServeMode),
      onWorktreeLifecycle: emitPluginWorktreeLifecycle
    }
  )
  if (window.isDestroyed() || state.mainWindow !== window || state.isQuitting) {
    throw new Error('Main window closed while preparing services')
  }
  // Attach durable diagnostic pulls now, defer process launch past first paint.
  initTccPromptNotice(window, { deferWatchUntilReadyToShow: true })
  rateLimits.attach(window)
}
