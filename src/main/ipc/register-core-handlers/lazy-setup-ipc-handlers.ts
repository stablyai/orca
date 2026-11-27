import type { CodexAccountService } from '../../codex-accounts/service'
import type { KeybindingService } from '../../keybindings/keybinding-service'
import type { Store } from '../../persistence/loading-store/store'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

export const CLI_IPC_CHANNELS = [
  'cli:getInstallStatus',
  'cli:install',
  'cli:remove',
  'cli:getWslInstallStatus',
  'cli:installWsl',
  'cli:removeWsl'
] as const

export const PREFLIGHT_IPC_CHANNELS = [
  'preflight:check',
  'preflight:detectAgents',
  'preflight:zcodeInteractiveCapability',
  'preflight:refreshAgents',
  'preflight:detectRemoteAgents',
  'preflight:detectRemoteWindowsTerminalCapabilities'
] as const

export const ONBOARDING_IPC_CHANNELS = [
  'onboarding:get',
  'onboarding:update',
  'onboarding:getChatUiLaunchTipVariant'
] as const

export const CODEX_CONFIG_SYNC_IPC_CHANNELS = ['codexConfigSync:status'] as const

export const LOCALHOST_WORKTREE_LABELS_IPC_CHANNELS = ['localhostWorktreeLabels:register'] as const

export const SHELL_IPC_CHANNELS = [
  'shell:openPath',
  'shell:openInFileManager',
  'shell:openInExternalEditor',
  'shell:openForwardedUrl',
  'shell:openUrl',
  'shell:openFilePath',
  'shell:openFileUri',
  'shell:pathsExist',
  'shell:pathExists',
  'shell:pickDirectory',
  'shell:pickAttachment',
  'shell:pickAttachments',
  'shell:pickImage',
  'shell:pickRepoIconImage',
  'shell:pickAudio'
] as const

export const DASHBOARD_POPOUT_IPC_CHANNELS = [
  'dashboardPopout:open',
  'dashboard:publishSnapshot',
  'dashboard:requestSnapshot',
  'dashboard:getPopoutOpen',
  'dashboardPopout:revealAgent',
  'dashboardPopout:ackAgent'
] as const

export function registerLazySetupIpcHandlers(
  store: Store,
  codexAccounts: CodexAccountService,
  keybindings?: KeybindingService
): void {
  registerLazyIpcHandleGroup(CLI_IPC_CHANNELS, async (ipc) => {
    const { registerCliHandlers } = await import('../cli')
    registerCliHandlers(ipc)
  })
  registerLazyIpcHandleGroup(PREFLIGHT_IPC_CHANNELS, async (ipc) => {
    const { registerPreflightHandlers } = await import('../preflight/preflight')
    registerPreflightHandlers(store, ipc)
  })
  registerLazyIpcHandleGroup(ONBOARDING_IPC_CHANNELS, async (ipc) => {
    const { registerOnboardingHandlers } = await import('../onboarding')
    registerOnboardingHandlers(store, ipc)
  })
  registerLazyIpcHandleGroup(CODEX_CONFIG_SYNC_IPC_CHANNELS, async (ipc) => {
    const { registerCodexConfigSyncHandlers } = await import('../accounts/codex-config-sync')
    registerCodexConfigSyncHandlers(codexAccounts.runtimeHomeService, ipc)
  })
  registerLazyIpcHandleGroup(LOCALHOST_WORKTREE_LABELS_IPC_CHANNELS, async (ipc) => {
    const { registerLocalhostWorktreeLabelHandlers } =
      await import('../ports/localhost-worktree-labels')
    registerLocalhostWorktreeLabelHandlers(store, ipc)
  })
  registerLazyIpcHandleGroup(SHELL_IPC_CHANNELS, async (ipc) => {
    const { registerShellHandlers } = await import('../shell/shell')
    registerShellHandlers(store, undefined, ipc)
  })
  registerLazyIpcHandleGroup(DASHBOARD_POPOUT_IPC_CHANNELS, async (ipc) => {
    const { registerDashboardPopoutHandlers } = await import('../dashboard/dashboard-popout')
    registerDashboardPopoutHandlers(store, keybindings, ipc)
  })
}
