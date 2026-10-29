import type { BrowserWindow, Tray } from 'electron'
import { app } from 'electron'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { OpenCodeUsageStore } from '../opencode-usage/store'
import type { MuseUsageStore } from '../muse-usage/store'
import type { CodexAccountService } from '../codex-accounts/service'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { ClaudeRuntimeAuthService } from '../claude-accounts/runtime-auth-service'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RateLimitService } from '../rate-limits/service'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { DesktopRelayService } from '../runtime/mobile-cloud-relay/desktop-relay-service'
import type { DesktopRelayServiceInstaller } from '../runtime/mobile-cloud-relay/desktop-relay-service-installer'
import type { DesktopPushService } from '../runtime/push/desktop-push-service'
import type { StarNagService } from '../star-nag/service'
import type { AgentAwakeService } from '../agent-awake-service'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'
import type { AutomationService } from '../automations/service'
import type { PluginService } from '../plugins/plugin-service'
import type { PluginKillListService } from '../plugins/catalog/plugin-kill-list-service'
import type { PluginAutoUpdater } from '../plugins/catalog/plugin-auto-updater'
import type { PluginMarketplaceService } from '../plugins/catalog/plugin-marketplace-service'
import type { PluginMarketplaceInstaller } from '../plugins/catalog/plugin-marketplace-installer'
import type { KeybindingService } from '../keybindings/keybinding-service'
import type { RelayBrokerStatus } from '../runtime/mobile-cloud-relay/relay-session-broker-contract'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import type { GpuFallbackMarker, GpuFallbackEnvironment } from './gpu-fallback-marker'
import type { createCodexSessionMigrationScheduler } from '../codex/codex-session-migration-scheduler'
import type { getDevInstanceIdentity } from './dev-instance-identity'
import type { createServeDesktopActivationGate } from './serve-desktop-activation'
import type { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import type { createWindowsShellPathHydration } from './windows-shell-path-hydration'
import type { ServeOptions } from './main-process-serve'
import type { HangDetectionMarker } from '../hang-watchdog/hang-detection-marker'
import { ServeReadinessPublisher } from '../server/serve-readiness'
import { PluginInstallLinkState, SkillShareDeepLinkState } from './skill-share-deep-link-state'
import { OsOpenedDocumentState } from './os-opened-documents'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker
} from '../crash-reporting/gpu-crash-fallback-decision'
import type { GpuCrashDiagnosticsRecorder } from '../crash-reporting/gpu-crash-diagnostics'
import { createWebContentsTimedFlag } from './web-contents-timed-flag'
import type { ProfileStateStorageClassification } from '../persistence/profile-state/profile-state-storage-classification'
import type { ProfileStateRuntimeAdmission } from '../persistence/profile-state/profile-state-access'

export type ProfileStateStartupMetadata = {
  backend: 'sqlite'
  classification: ProfileStateStorageClassification
  runtime: 'desktop' | 'orcad'
  migrated: boolean
}

function createInitialProfileStateStartup(): ProfileStateStartupMetadata | null {
  return null
}

function createInitialProfileStateAdmission(): ProfileStateRuntimeAdmission | undefined {
  return undefined
}

/** Mutable composition-root state shared by startup, window, serve, and quit phases. */
export const mainProcessState = {
  mainWindow: null as BrowserWindow | null,
  // Never cleared: closing the last main window still quits on Windows/Linux.
  hasOpenedMainWindow: false,
  /** User quit bypasses running-process confirmation during close. */
  isQuitting: false,
  store: null as Store | null,
  profileStateStartup: createInitialProfileStateStartup(),
  profileStateAdmission: createInitialProfileStateAdmission(),
  stats: null as StatsCollector | null,
  claudeUsage: null as ClaudeUsageStore | null,
  codexUsage: null as CodexUsageStore | null,
  openCodeUsage: null as OpenCodeUsageStore | null,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: widens the null slot to the store type assigned by main-process-observers.
  museUsage: null as MuseUsageStore | null,
  codexAccounts: null as CodexAccountService | null,
  codexRuntimeHome: null as CodexRuntimeHomeService | null,
  codexSessionMigration: null as ReturnType<typeof createCodexSessionMigrationScheduler> | null,
  claudeAccounts: null as ClaudeAccountService | null,
  claudeRuntimeAuth: null as ClaudeRuntimeAuthService | null,
  runtime: null as OrcaRuntimeService | null,
  rateLimits: null as RateLimitService | null,
  runtimeRpc: null as OrcaRuntimeRpcServer | null,
  serveReadinessPublisher: new ServeReadinessPublisher(),
  desktopRelayService: null as DesktopRelayService | null,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: widens the null slot to the installer assigned by main-process-relay-startup.
  desktopRelayInstaller: null as DesktopRelayServiceInstaller | null,
  desktopPushService: null as DesktopPushService | null,
  desktopRelayStatus: 'offline' as RelayBrokerStatus,
  desktopRelayCellUrl: undefined as string | undefined,
  pendingUnpairedDeviceAuthFailure: false,
  // Advertise headless browser panes only when offscreen display initialization succeeds.
  headlessBrowserDisplayAvailable: false,
  starNag: null as StarNagService | null,
  agentAwakeService: null as AgentAwakeService | null,
  uninstallRepoMaintenanceIdleGate: null as (() => Promise<void>) | null,
  repoMaintenanceShutdown: Promise.resolve() as Promise<void>,
  crashReports: null as CrashReportStore | null,
  unsubscribeAgentAwakeStatusChanges: null as (() => void) | null,
  unsubscribeSystemResumeBroadcast: null as (() => void) | null,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: widens the null slot to the stop function assigned by main-process-observers.
  stopDesktopPresenceReporter: null as (() => void) | null,
  watcherShutdownPromise: null as Promise<void> | null,
  watcherShutdownDone: false,
  automations: null as AutomationService | null,
  pluginService: null as PluginService | null,
  pluginKillListService: null as PluginKillListService | null,
  pluginMarketplaceService: null as PluginMarketplaceService | null,
  pluginMarketplaceInstaller: null as PluginMarketplaceInstaller | null,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: widens the null initial value; assigned once plugins start.
  pluginAutoUpdater: null as PluginAutoUpdater | null,
  keybindings: null as KeybindingService | null,
  // Timed reload flags cannot leak to later loads; recovery did-finish-load must preserve live PTYs (#5787).
  expectedRendererReload: createWebContentsTimedFlag(),
  recoveryReloadInFlight: createWebContentsTimedFlag(),
  // Retain Settings clicks until the renderer pulls after listener mount.
  pendingOpenSettings: createWebContentsTimedFlag(),
  // Why: a confirmed Quit Completely can open the window; its renderer pulls this one-shot on mount.
  pendingQuitAndStopAllSessions: createWebContentsTimedFlag(),
  skillShareDeepLinks: new SkillShareDeepLinkState(),
  pluginInstallLinks: new PluginInstallLinkState(),
  // Buffer OS Open With before any renderer listener exists.
  osOpenedDocuments: new OsOpenedDocumentState(),
  // Window existence does not prove listener readiness; only the renderer pull does, otherwise pushes silently vanish.
  osDocumentOpenListenerReady: false,
  firstWindowStartupServicesReady: Promise.resolve(),
  // Publish proxy readiness for fetchers; window creation can proceed behind the request guard.
  initialProxyApplicationReady: Promise.resolve(),
  // Why awaited before runtime services: the first window's session and UI reads must see a
  // committed WSL move's rewrite. Bounded, never rejects, and resolved at once with the gate off.
  wslMoveStartupRewriteReady: Promise.resolve(),
  // Parallel i18n gates the translated failure dialog only; phase failures are handled by readiness composition.
  mainProcessI18nReady: Promise.resolve(),
  managedWslCliReconciliationReady: Promise.resolve(),
  managedWslCliStartupBarrierReady: Promise.resolve(),
  // Fail-open serve barrier exposes pending migration to headless clients; settled is the off-Windows no-op.
  managedWslCliReconciliationStatus: 'settled' as 'pending' | 'settled' | 'failed',
  gpuCrashFallbackTracker: new GpuCrashFallbackTracker({
    windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
    threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
  }),
  activeGpuFallbackMarker: null as GpuFallbackMarker | null,
  gpuFallbackActiveThisLaunch: false,
  gpuFeatureStatus: null as Electron.GPUFeatureStatus | null,
  gpuCrashDiagnostics: null as GpuCrashDiagnosticsRecorder | null,
  localPtyStartupReady: Promise.resolve(),
  localPtyProviderStartupReady: Promise.resolve(),
  isServeMode: false,
  devInstanceIdentity: null as ReturnType<typeof getDevInstanceIdentity> | null,
  devAgentHookEndpointNamespace: undefined as string | undefined,
  startupDiagnosticsEnabled: false,
  desktopActivationGate: null as ReturnType<typeof createServeDesktopActivationGate> | null,
  activeOrcaProfile: null as ReturnType<typeof ensureActiveOrcaProfile> | null,
  windowsShellPathHydration: null as ReturnType<typeof createWindowsShellPathHydration> | null,
  shellPathReady: Promise.resolve(),
  hangDetection: null as HangDetectionMarker | null,
  skillTransactionRecovery: Promise.resolve() as Promise<unknown>,
  serveOptions: null as ServeOptions | null,
  desktopWindow: null as BrowserWindow | null,
  agentBrowserBridge: null as AgentBrowserBridge | null,
  emulatorBridge: null as EmulatorBridge | null,
  tray: null as Tray | null
}

export function gpuFallbackEnvironment(): GpuFallbackEnvironment {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    platform: process.platform
  }
}
