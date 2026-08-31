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
  /** Returns the app identity currently exposed to native chrome and the titlebar. */
  getIdentity: () => Promise<AppIdentity>
  /** Returns a URL base for feature-wall assets. In dev this is Vite /@fs;
   *  in packaged builds this is file:// resources. Renderer appends filenames. */
  getFeatureWallAssetBaseUrl: () => Promise<string>
  /** Relaunches the app (app.relaunch() + app.exit(0)) for settings that need a full restart to apply. */
  relaunch: () => Promise<void>
  /** Restarts Orca through the normal quit pipeline so daemon-backed terminal
   *  sessions survive and can reattach after the new process starts. */
  restart: () => Promise<void>
  /** Reloads the current app renderer through main so expected renderer
   *  teardown can be classified before Electron emits process-gone events. */
  reload: () => Promise<void>
  /** Stages the renderer's final state synchronously before unload. */
  stageBeforeUnloadSync: (args: {
    sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
    ui: Partial<PersistedUIState>
  }) => void
  /** Resolves once the last staged checkpoint is durably written; rejects if that
   *  write failed, so a reload/restart can abort instead of losing the snapshot. */
  awaitBeforeUnloadCheckpoint: () => Promise<void>
  /** Resolves when the daemon PTY provider and hook receiver have either
   *  started or failed open for the first BrowserWindow. */
  awaitFirstWindowStartupServices: () => Promise<void>
  /** Inventories retained PTYs and restores durable structured ownership before renderer adoption. */
  prepareTerminalStartupRestoration: () => Promise<void>
  /** Reconciles legacy worker authority around persisted terminal reconnect. */
  recoverLegacyWorkerTerminalsForRendererStartup: () => Promise<void>
  /** Emits a startup benchmark marker when ORCA_STARTUP_DIAGNOSTICS is enabled. */
  startupDiagnostic: (event: string, details?: Record<string, unknown>) => Promise<void>
  /** macOS active input mode, or layout ID when no IME is selected (e.g. `com.apple.keylayout.PolishPro`).
   *  Distinguishes CJK IMEs and Option-layer-composing layouts that look like US QWERTY (issue #1205).
   *  Returns null on non-Darwin or when the defaults read fails. */
  getKeyboardInputSourceId: () => Promise<string | null>
  /** Physical Mission Control chords before layout resolution. */
  getMacCapturedDigitRowChords: () => Promise<MacCapturedDigitRowChord[]>
  /** Active macOS layout characters without Option, or null off macOS or when the native probe fails. */
  getKeyboardLayoutSnapshot: () => Promise<KeyboardLayoutSnapshot | null>
  /** Subscribes to active macOS input-source changes. No-op in the browser fallback. */
  onKeyboardLayoutChanged: (callback: (event: KeyboardLayoutChangeEvent) => void) => () => void
  /** Updates the macOS Dock unread badge. No-op on Windows/Linux. */
  setUnreadDockBadgeCount: (count: number) => Promise<void>
  /** Resolves the launch directory for global Floating Terminal tabs. */
  getFloatingTerminalCwd: (args?: FloatingTerminalCwdRequest) => Promise<string>
  /** Resolves Orca's app-owned directory for auto-created Floating Workspace
   *  markdown notes. */
  getFloatingMarkdownDirectory: () => Promise<string>
  /** Opens a native picker for markdown documents, rooted in the floating
   *  workspace, and authorizes the selected file for editor reads/writes. */
  pickFloatingMarkdownDocument: () => Promise<MarkdownDocument | null>
  /** Opens a native directory picker and authorizes the selected directory
   *  for Floating Workspace markdown file creation. */
  pickFloatingWorkspaceDirectory: () => Promise<string | null>
  /** Persists flag-gated terminal render evidence under app-owned userData. */
  writeTerminalRenderDesyncEvidence: (
    args: WriteTerminalRenderDesyncEvidenceArgs
  ) => Promise<WriteTerminalRenderDesyncEvidenceResult>
}

/** Panel contribution as surfaced by the main-process plugin service. */

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
