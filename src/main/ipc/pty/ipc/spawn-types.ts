import type { PtySpawnOutcome } from '../spawn-outcome'
import type { PaneSpawnReservation } from '../pane/spawn-reservation'
import type { PaneSpawnOperation } from '../pane/pane-spawn-operation'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalStartupCwdMissingDirFallback } from '../../../../shared/terminal-startup-cwd'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { Store } from '../../../persistence'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type {
  CodexHomePtySpawnedLifecycleArgs,
  GetSelectedCodexHomePath,
  PrepareClaudeAuth,
  PrepareCodexSessionResume
} from '../host-env/types'
import type { StablePaneOwner } from '../pane/stable-owner'
import type { ReplacedPaneOwner } from '../pane/replaced-pane-owner'
import type { ResolvedPtyHost } from '../provider/registry'
import type { PtySpawnCodexResumeDeps } from '../spawn-host-env'

export type PtySpawnIpcArgs = {
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  commandDelivery?: 'renderer' | 'provider'
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  // Untyped on purpose: only `'saved'` marks a resume built from saved facts.
  resumeOrigin?: unknown
  launchToken?: unknown
  launchAgent?: TuiAgent
  startupCommandDelivery?: StartupCommandDelivery
  connectionId?: string | null
  worktreeId?: string
  sessionId?: string
  // A view attaches to the main-started session or starts nothing.
  attachOnlyView?: boolean
  shellOverride?: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  terminalKittyKeyboardProtocol?: boolean
  terminalColorQueryReplies?: {
    foreground?: unknown
    background?: unknown
  }
  // Declare hidden state before output so main owns startup queries.
  initiallyHidden?: boolean
  // Persist pane binding before returning spawn so an abrupt app kill cannot lose daemon history.
  tabId?: string
  leafId?: string
  // Explicit restart must replace a live owner that ordinary spawn would reattach.
  replacesPtyId?: string
  // Validate untyped placement only through parseTerminalPanePlacement.
  placement?: unknown
  // Accept declared restore intent only through isRestoreSpawnIntent.
  spawnIntent?: unknown
  // Validate untyped launch input through AgentLaunch.safeParse.
  agentLaunch?: unknown
  // Main validates renderer telemetry; retain unknown input types at the IPC boundary.
  telemetry?: {
    agent_kind?: unknown
    launch_source?: unknown
    request_kind?: unknown
  }
}

export type AdoptStablePaneArgs = {
  cols: number
  rows: number
  cwd?: string
  connectionId?: string | null
  worktreeId?: string
  preAllocatedHandle?: string
  tabId: string
  leafId: string
  onAdopted?: (result: PtySpawnResult) => void
  onOutcome?: (outcome: PtySpawnOutcome, operation: PaneSpawnOperation) => void
  completed?: AdoptStablePaneResult
  ownsPaneSpawnReservation?: true
  reservation?: PaneSpawnReservation
  stoppedPtyId?: string
  renderer?: boolean
  signal?: AbortSignal
  spawnFresh?: (operation: PaneSpawnOperation) => Promise<PtySpawnResult>
  /** See StablePaneSpawnContext; adoption holds the pane's reservation through its fresh launch. */
  keepAbsentBinding?: (dead: ReplacedPaneOwner) => void
  attachOnlyView?: true
}

export type AdoptStablePaneResult = {
  operation?: PaneSpawnOperation
  result: PtySpawnResult
  outcome?: PtySpawnOutcome
  owner: StablePaneOwner
  materialized?: true
}

export type PtySpawnIpcDeps = PtySpawnCodexResumeDeps & {
  runtime?: OrcaRuntimeService
  store?: Store
  getSettings?: () => GlobalSettings
  getSelectedCodexHomePath?: GetSelectedCodexHomePath
  prepareClaudeAuth?: PrepareClaudeAuth
  options?: {
    prepareCodexSessionResume?: PrepareCodexSessionResume
    onCodexHomePtySpawned?: (args: CodexHomePtySpawnedLifecycleArgs) => void
  }
  getLocalPtyStartupPromise: (hostId?: ResolvedPtyHost) => Promise<void> | undefined
  adoptStablePane: (args: AdoptStablePaneArgs) => Promise<AdoptStablePaneResult | null>
  assertWorkspaceAcceptsNewPty: (
    worktreeId: string | undefined,
    sessionId?: string
  ) => Promise<void> | void
  resolvePtySpawnStartupCwd: (
    worktreeId: string | undefined,
    cwd: string | undefined,
    missingDirFallback?: TerminalStartupCwdMissingDirFallback
  ) => string | undefined
  transitionSpawnHiddenRendererPtyDeliveryState: (id: string, hidden: boolean) => void
  trustedTerminalHandleEnv: Set<string>
  sendPtySpawnedToRenderer: (id: string) => void
  syncPtyBackgroundedDelivery: (id: string, caller: string) => void
  stopReplacedPty: (id: string) => Promise<void>
}
