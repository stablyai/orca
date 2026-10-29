import type { UiLanguageDetection } from '../../shared/ui-locale'
import type { AppIdentity } from '../../shared/app-identity'
import type { E2EConfig } from '../../shared/e2e-config'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  WriteTerminalRenderDesyncEvidenceArgs,
  WriteTerminalRenderDesyncEvidenceResult
} from '../../shared/terminal-render-desync-evidence'
import type { MacCapturedDigitRowChord } from '../../shared/macos-symbolic-hotkeys'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { FloatingTerminalCwdRequest } from '../../shared/ui-chrome-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { KeyboardLayoutSnapshot } from '../../shared/keyboard-layout-snapshot'
import type { KeyboardLayoutChangeEvent } from '../../shared/keyboard-layout-events'

export type AppApi = {
  getSystemLanguageDetection?: (
    browserPreferences?: readonly string[]
  ) => Promise<UiLanguageDetection | null>
  isProfileStateSaveDelayed: () => Promise<boolean>
  onProfileStateSaveDelayChanged: (callback: (delayed: boolean) => void) => () => void
  getIdentity: () => Promise<AppIdentity>
  /** Local Windows desktop elevation; null when unavailable. Does not describe remote hosts. */
  getWindowsAdministratorStatus: () => Promise<boolean | null>
  /** Restarts the installed Windows desktop with administrator approval and replaces its local terminal host. */
  restartAsAdministrator: () => Promise<void>
  /** Append filenames to this base: Vite /@fs in dev, file:// resources when packaged. */
  getFeatureWallAssetBaseUrl: () => Promise<string>
  /** Uses app.exit(0), bypassing normal quit handling. */
  relaunch: () => Promise<void>
  /** Uses normal quit handling so daemon terminals survive for reattachment. */
  restart: () => Promise<void>
  /** Main classifies teardown before Electron emits process-gone events. */
  reload: () => Promise<void>
  stageBeforeUnloadSync: (args: {
    sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
    ui: Partial<PersistedUIState>
  }) => void
  /** Waits for durable persistence; rejection lets reload/restart abort without losing state. */
  awaitBeforeUnloadCheckpoint: () => Promise<void>
  /** Waits for daemon PTY and hook startup to succeed or fail open. */
  awaitFirstWindowStartupServices: () => Promise<void>
  /** Waits for shell PATH and managed WSL CLI registration, independently of PTY startup. */
  awaitGitEnvironmentStartupBarrier: () => Promise<void>
  /** Restore durable PTY ownership before renderer adoption. */
  prepareTerminalStartupRestoration: () => Promise<void>
  /** Whether this machine's runtime holds a structured chat, saved or live. */
  holdsStructuredAgentSessions: () => Promise<boolean>
  onStructuredAgentSessionsHeldChanged: (callback: (held: boolean) => void) => () => void
  recoverLegacyWorkerTerminalsForRendererStartup: () => Promise<void>
  /** Enabled only by ORCA_STARTUP_DIAGNOSTICS. */
  startupDiagnostic: (event: string, details?: Record<string, unknown>) => Promise<void>
  /** macOS input mode or non-IME layout ID; null off macOS or if the defaults read fails. */
  getKeyboardInputSourceId: () => Promise<string | null>
  /** Physical Mission Control chords before layout resolution. */
  getMacCapturedDigitRowChords: () => Promise<MacCapturedDigitRowChord[]>
  /** Active macOS layout characters without Option, or null off macOS or when the native probe fails. */
  getKeyboardLayoutSnapshot: () => Promise<KeyboardLayoutSnapshot | null>
  /** Subscribes to active macOS input-source changes. No-op in the browser fallback. */
  onKeyboardLayoutChanged: (callback: (event: KeyboardLayoutChangeEvent) => void) => () => void
  /** No-op on Windows/Linux. */
  setUnreadDockBadgeCount: (count: number) => Promise<void>
  getFloatingTerminalCwd: (args?: FloatingTerminalCwdRequest) => Promise<string>
  /** App-owned directory for auto-created Floating Workspace notes. */
  getFloatingMarkdownDirectory: () => Promise<string>
  /** Picks a Floating Workspace document and authorizes editor reads/writes. */
  pickFloatingMarkdownDocument: () => Promise<MarkdownDocument | null>
  /** Picks a directory and authorizes Floating Workspace markdown creation. */
  pickFloatingWorkspaceDirectory: () => Promise<string | null>
  /** Persists flag-gated terminal render evidence under app-owned userData. */
  writeTerminalRenderDesyncEvidence: (
    args: WriteTerminalRenderDesyncEvidenceArgs
  ) => Promise<WriteTerminalRenderDesyncEvidenceResult>
}

export type PlatformApi = {
  get: () => {
    platform: NodeJS.Platform
    osRelease: string
    arch: string
    /** Login shell or ComSpec when available. */
    shell: string
    displayServer: 'wayland' | 'x11' | null
  }
}

export type E2EApi = {
  getConfig: () => E2EConfig
}
