import type { AutomationUsageClient } from '../../shared/backend/backend-service-contract'
import type { StatsCollector } from '../stats/collector'
import type { UsageWorktreeHistory } from '../usage/worktree-attribution/usage-worktree-history'
import type { CodexAccountService } from '../codex-accounts/service'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { ClaudeRuntimeAuthService } from '../claude-accounts/runtime-auth-service'
import type { OrcaAccountService } from '../orca-profiles/orca-account-service'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RateLimitService } from '../rate-limits/service/rate-limit-service'
import type { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import type { RelayHost } from '../runtime/mobile-cloud-relay/relay-host-install'
import type { DesktopPushService } from '../runtime/push/desktop-push-service'
import type { StarNagService } from '../star-nag/service'
import type { AutomationService } from '../automations/automation-service'
import type { PluginService } from '../plugins/plugin-service'
import type { PluginKillListService } from '../plugins/catalog/plugin-kill-list-service'
import type { PluginInstallStatsService } from '../plugins/catalog/plugin-install-stats-service'
import type { PluginAutoUpdater } from '../plugins/catalog/plugin-auto-updater'
import type { PluginUpdateReviewNotices } from '../plugins/catalog/plugin-update-review-notices'
import type { PluginMarketplaceService } from '../plugins/catalog/plugin-marketplace-service'
import type { PluginMarketplaceInstaller } from '../plugins/catalog/plugin-marketplace-installer'
import type { KeybindingService } from '../keybindings/keybinding-service'
import type { MobileRelayStatusDetail } from '../../shared/remote-runtime/relay/mobile-relay-status'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import type { createCodexSessionMigrationScheduler } from '../codex/history/backfill/codex-session-migration-scheduler'
import type { Store } from '../persistence/loading-store/store'
import type { RendererShutdownCheckpointService } from './renderer-shutdown-checkpoint-service'
import { ServeReadinessPublisher } from '../server/serve-readiness'
import { beginProfileShutdownCheckpoint } from '../persistence/profile-shutdown-checkpoint'

/** The desktop application core's services; composition fills the slots, shutdown retires them. */
export class DesktopCore {
  stats: StatsCollector | null = null
  usageWorktreeHistory: UsageWorktreeHistory | null = null
  claudeUsage: AutomationUsageClient | null = null
  codexUsage: AutomationUsageClient | null = null
  codexAccounts: CodexAccountService | null = null
  codexRuntimeHome: CodexRuntimeHomeService | null = null
  codexSessionMigration: ReturnType<typeof createCodexSessionMigrationScheduler> | null = null
  claudeAccounts: ClaudeAccountService | null = null
  claudeRuntimeAuth: ClaudeRuntimeAuthService | null = null
  orcaAccount: OrcaAccountService | null = null
  runtime: OrcaRuntimeService | null = null
  rateLimits: RateLimitService | null = null
  runtimeRpc: OrcaRuntimeRpcServer | null = null
  readonly serveReadinessPublisher = new ServeReadinessPublisher()
  relayHost: RelayHost | null = null
  desktopPushService: DesktopPushService | null = null
  desktopRelayStatus: MobileRelayStatusDetail = { status: 'offline' }
  pendingUnpairedDeviceAuthFailure = false
  starNag: StarNagService | null = null
  uninstallRepoMaintenanceIdleGate: (() => Promise<void>) | null = null
  uninstallHookStatusRepublish: (() => void) | null = null
  repoMaintenanceShutdown: Promise<void> = Promise.resolve()
  watcherShutdownDone = false
  automations: AutomationService | null = null
  pluginService: PluginService | null = null
  pluginKillListService: PluginKillListService | null = null
  pluginInstallStatsService: PluginInstallStatsService | null = null
  pluginMarketplaceService: PluginMarketplaceService | null = null
  pluginMarketplaceInstaller: PluginMarketplaceInstaller | null = null
  pluginAutoUpdater: PluginAutoUpdater | null = null
  pluginUpdateReviewNotices: PluginUpdateReviewNotices | null = null
  keybindings: KeybindingService | null = null
  emulatorBridge: EmulatorBridge | null = null
  skillTransactionRecovery: Promise<unknown> = Promise.resolve()
  rendererCheckpoint: RendererShutdownCheckpointService | null = null

  private profileCheckpoint: Promise<void> | null = null

  /** One final-profile checkpoint per process, shared by quit and startup-failure cleanup. */
  checkpointProfile(
    store: Pick<Store, 'flushPendingOrThrowAsync'> | null,
    paneGridFlush: () => Promise<void> | null | undefined
  ): Promise<void> {
    this.profileCheckpoint ??= beginProfileShutdownCheckpoint(store, paneGridFlush())
    return this.profileCheckpoint
  }
}
