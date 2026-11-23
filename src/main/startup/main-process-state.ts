import type { BackendSupervisor } from '../backend-desktop/backend-supervisor'
import { type BrowserWindow, type Tray, app } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { NativeSettingsProjection } from '../core-desktop/native-settings-projection'
import type { AgentAwakeService } from '../power/agent-awake-service'
import type { CrashReportStore } from '../crash-reporting/reports/crash-report-store'
import type { AgentBrowserBridge } from '../browser/agent-browser/agent-browser-bridge'
import type { GpuFallbackMarker, GpuFallbackEnvironment } from './gpu-recovery/gpu-fallback-marker'
import type { getDevInstanceIdentity } from './profile-startup/dev-instance-identity'
import type { createServeDesktopActivationGate } from './serve-launch/serve-desktop-activation'
import type { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import type { createWindowsShellPathHydration } from './shell-environment/windows-shell-path-hydration'
import type { ServeOptions } from './serve-launch/serve-options'
import type { HangDetectionMarker } from '../hang-watchdog/hang-detection-marker'
import { DeepLinkState } from './deep-link-state'
import { DesktopCore } from '../core-desktop/desktop-core'
import { PluginInstallLinkState } from './open-routing/skill-share-deep-link-state'
import { OsOpenedDocumentState } from './open-routing/os-opened-documents'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker
} from '../crash-reporting/recovery/gpu-crash-fallback-decision'
import type { GpuCrashDiagnosticsRecorder } from '../crash-reporting/capture/gpu-crash-diagnostics'
import { createWebContentsTimedFlag } from './main-window/web-contents-timed-flag'
import type { ProfileStateStorageClassification } from '../persistence/profile-state/database/profile-state-storage-classification'
import type { ProfileStateRuntimeAdmission } from '../persistence/profile-state/access/profile-state-access'

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

function createInitialBackendServices(): { backend: BackendSupervisor | null } {
  return { backend: null }
}

/** Mutable composition-root state shared by startup, window, serve, and quit phases. */
export const mainProcessState = {
  mainWindow: null as BrowserWindow | null,
  // Never cleared: closing the last main window still quits on Windows/Linux.
  hasOpenedMainWindow: false,
  /** User quit bypasses running-process confirmation during close. */
  isQuitting: false,
  store: null as Store | null,
  // Main's native consumers read settings through this; it never exposes the Store.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: widens the null slot assigned by main-process-ready-foundation.
  nativeSettings: null as NativeSettingsProjection | null,
  profileStateStartup: createInitialProfileStateStartup(),
  core: new DesktopCore(),
  profileStateAdmission: createInitialProfileStateAdmission(),
  ...createInitialBackendServices(),
  // Advertise headless browser panes only when offscreen display initialization succeeds.
  headlessBrowserDisplayAvailable: false,
  agentAwakeService: null as AgentAwakeService | null,
  crashReports: null as CrashReportStore | null,
  unsubscribeAgentAwakeStatusChanges: null as (() => void) | null,
  unsubscribeSystemResumeBroadcast: null as (() => void) | null,
  unsubscribeRefusedSaveRetry: null as (() => void) | null,
  unsubscribeWakeSignalClock: null as (() => void) | null,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: widens the null slot to the stop function assigned by main-process-observers.
  stopDesktopPresenceReporter: null as (() => void) | null,
  // Timed reload flags cannot leak to later loads; recovery did-finish-load must preserve live PTYs (#5787).
  expectedRendererReload: createWebContentsTimedFlag(),
  recoveryReloadInFlight: createWebContentsTimedFlag(),
  // Retain Settings clicks until the renderer pulls after listener mount.
  pendingOpenSettings: createWebContentsTimedFlag(),
  // Why: a confirmed Quit Completely can open the window; its renderer pulls this one-shot on mount.
  pendingQuitAndStopAllSessions: createWebContentsTimedFlag(),
  deepLinks: new DeepLinkState(),
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
  serveOptions: null as ServeOptions | null,
  desktopWindow: null as BrowserWindow | null,
  agentBrowserBridge: null as AgentBrowserBridge | null,
  tray: null as Tray | null
}

export function gpuFallbackEnvironment(): GpuFallbackEnvironment {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    platform: process.platform
  }
}
