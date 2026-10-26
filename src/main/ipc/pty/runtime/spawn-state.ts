import type { PtyRegistrationClaim } from '../../../runtime/runtime-terminal-state-records'
import type { PaneSpawnOperation } from '../pane/pane-spawn-operation'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch-runtime'
import type { SpawnIntent } from '../../../../shared/host-spawn-admission'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../../../providers/pty-provider-contract'
import type { CodexPaneHomeRoute } from '../../../codex/codex-pane-account-registry'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth-service'
import type { StablePaneOwner } from '../pane/stable-owner'
import type { PaneSpawnReservation } from '../pane/spawn-reservation'
import type { AdoptStablePaneResult } from '../ipc/spawn-types'
import type { PtyBindingSourceExpectation } from '../../../persistence'
import type { TerminalPanePlacement } from '../../../../shared/terminal-pane-placement'
import type { ResumeSpawnAdmission } from '../host-env/saved-resume-admission'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  SleepingAgentLaunchConfig,
  AgentProviderSessionMetadata
} from '../../../../shared/agent-session-resume'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../../../shared/agent-session-host-authority'
import { localProvider } from '../provider/registry'
import type { PaneResumeOutcome } from '../../../../shared/workspace-layout/workspace-layout-published'
import type { StartupCwdFallback } from '../../../../shared/startup-cwd-fallback'

export type RuntimePtySpawnState = {
  deps: PtyRuntimeControllerDeps
  args: RuntimePtySpawnArgs
  codexHomeLaunchStartedAt: Date | undefined
  codexHomeLaunchStartedSequence: number | undefined
  spawnRequestedAt: number
  preAdoptedStablePane: AdoptStablePaneResult | null
  reattachedCodexHomeRoutes: Map<string, CodexPaneHomeRoute | null>
  cwd: string | undefined
  requestedCwd: string | undefined
  prevalidatedCwd: string | undefined
  startupCwdFallback: StartupCwdFallback | undefined
  correctStartupCwd?: string
  provider: IPtyProvider
  isClaudeLaunch: boolean
  terminalRuntimeOptions: { shellOverride?: string; terminalWindowsWslDistro?: string | null }
  daemonShellOverride: string | undefined
  isDaemonHostSpawn: boolean
  callerRequestedSessionId: string | undefined
  requestedSessionId: string | undefined
  sessionId: string | undefined
  effectiveSessionAppId: string | undefined
  isNewDaemonSession: boolean
  expectedWslDistro: string | null
  /** The host's verdict on the spawn's resume; a refused one starts the pane's plain shell. */
  resumeAdmission: ResumeSpawnAdmission | null
  codexSelectionTarget: CodexAccountSelectionTarget
  launchCommand: string | undefined
  claudeAuth: ClaudeRuntimeAuthPreparation | null
  shouldPersistHostSessionBinding: boolean
  hostSessionBinding:
    | {
        store: NonNullable<PtyRuntimeControllerDeps['store']>
        worktreeId: string
        tabId: string
        leafId: string
        expectedSourceBinding?: PtyBindingSourceExpectation
        placement?: TerminalPanePlacement
      }
    | undefined
  env: Record<string, string> | undefined
  requestedAgentTeamsPath: string | undefined
  selectedCodexHomePath: string | null
  codexResumeHomeSelected: boolean
  agentResumeUnavailable: boolean
  codexResumeArgvDropped: boolean
  /** The dropped resume owes the user a notice: the pane runs a fresh session. */
  codexResumeUnavailable: boolean
  skipCodexHomeEnv: boolean
  stripInheritedOrcaCodexHome: boolean
  spawnOptions: PtySpawnOptions
  hadSessionSizeBeforeAttach: boolean
  sessionSizeBeforeAttach: { cols: number; rows: number } | undefined
  materializedPaneKey: string | null
  metadataLeafId: string | null
  metadataPaneKey: string | null
  spawnIdentityPaneKey: string | null
  paneSpawnReservationKey: string | null
  paneSpawnReservation: PaneSpawnReservation | null
  finishTerminalInstall: () => void
  result: PtySpawnResult & {
    stablePaneOwner?: { handle: string; tabId: string; leafId: string }
    agentSessionEnsure?: unknown
  }
  stablePaneOwner: StablePaneOwner | null
  stablePaneBindingPersisted: boolean
  rejectedRegistrationCandidate: PtySpawnResult | null
  pendingRegistrationPtyId: string | null
  pendingRegistrationClaim?: PtyRegistrationClaim
  reconciledSnapshotSeq: number | null
  snapshotKittyFlagsCoverReconciledSeq: boolean
  preparedProvisionalExecutionContext: boolean
  releaseWorktreeSpawn: (() => void) | undefined
  reportPtySpawnCommitted: () => void
  preSpawnHiddenMarkId: string | null
}

export type RuntimePtySpawnArgs = {
  cols: number
  rows: number
  cwd?: string
  command?: string
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
  commandDelivery?: 'renderer' | 'provider'
  startupCommandDelivery?: StartupCommandDelivery
  telemetry?: {
    agent_kind?: unknown
    launch_source?: unknown
    request_kind?: unknown
  }
  env?: Record<string, string>
  envToDelete?: string[]
  resumeProviderSession?: AgentProviderSessionMetadata
  /** `saved`: built from a pane's saved facts, which the host refuses for a chat's conversation. */
  resumeOrigin?: 'saved'
  connectionId?: string | null
  worktreeId?: string
  preAllocatedHandle?: string
  tabId?: string
  leafId?: string
  sessionId?: string
  shellOverride?: string
  /** Planned command quoting determines the PTY runtime shell. */
  launchRuntime?: AgentLaunchRuntime
  isNewSession?: boolean
  /** No renderer view exists at spawn; main owns delivery and query replies until one mounts. */
  initiallyHidden?: boolean
  persistHostSessionBinding?: boolean
  expectedSourceBinding?: PtyBindingSourceExpectation
  placement?: TerminalPanePlacement
  terminalKittyKeyboardProtocol?: boolean
  terminalColorQueryReplies?: { foreground?: string; background?: string }
  agentSessionEnsure?: {
    claim: AgentSessionExecutionClaim
    surface: AgentSessionSurfaceBinding
  }
  agentSessionCreateOperationId?: string
  spawnIntent?: SpawnIntent
  signal?: AbortSignal
  refuseSleptWorktree?: boolean
  onPtySpawnCommitted?: () => void
  /** Publish fresh resume outcome before writing its pane binding. */
  onResumeOutcome?: (ptyId: string, outcome: PaneResumeOutcome) => void
  paneSpawnOperation?: PaneSpawnOperation
  adoptedStablePane?: {
    result: PtySpawnResult
    owner: {
      handle?: string
      tabId: string
      leafId: string
      ptyId: string
      incarnationId?: string
    }
    materialized?: true
  }
}

export function createRuntimePtySpawnState(
  deps: PtyRuntimeControllerDeps,
  args: RuntimePtySpawnArgs
): RuntimePtySpawnState {
  return {
    deps,
    args,
    codexHomeLaunchStartedAt: undefined,
    codexHomeLaunchStartedSequence: undefined,
    spawnRequestedAt: Date.now(),
    preAdoptedStablePane: null,
    reattachedCodexHomeRoutes: new Map(),
    cwd: undefined,
    requestedCwd: undefined,
    prevalidatedCwd: undefined,
    startupCwdFallback: undefined,
    provider: localProvider,
    isClaudeLaunch: false,
    terminalRuntimeOptions: {},
    daemonShellOverride: undefined,
    isDaemonHostSpawn: false,
    callerRequestedSessionId: undefined,
    requestedSessionId: undefined,
    sessionId: undefined,
    effectiveSessionAppId: undefined,
    isNewDaemonSession: false,
    expectedWslDistro: null,
    resumeAdmission: null,
    codexSelectionTarget: { runtime: 'host' },
    launchCommand: undefined,
    claudeAuth: null,
    shouldPersistHostSessionBinding: false,
    hostSessionBinding: undefined,
    env: undefined,
    requestedAgentTeamsPath: undefined,
    selectedCodexHomePath: null,
    codexResumeHomeSelected: false,
    agentResumeUnavailable: false,
    codexResumeArgvDropped: false,
    codexResumeUnavailable: false,
    skipCodexHomeEnv: false,
    stripInheritedOrcaCodexHome: false,
    spawnOptions: { cols: args.cols, rows: args.rows },
    hadSessionSizeBeforeAttach: false,
    sessionSizeBeforeAttach: undefined,
    materializedPaneKey: null,
    metadataLeafId: null,
    metadataPaneKey: null,
    spawnIdentityPaneKey: null,
    paneSpawnReservationKey: null,
    paneSpawnReservation: null,
    finishTerminalInstall: () => {},
    result: { id: '' },
    stablePaneOwner: null,
    stablePaneBindingPersisted: false,
    rejectedRegistrationCandidate: null,
    pendingRegistrationPtyId: null,
    reconciledSnapshotSeq: null,
    snapshotKittyFlagsCoverReconciledSeq: true,
    preparedProvisionalExecutionContext: false,
    releaseWorktreeSpawn: undefined,
    reportPtySpawnCommitted: () => {},
    preSpawnHiddenMarkId: null
  }
}
