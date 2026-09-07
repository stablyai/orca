import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../../providers/types'
import type { CodexPaneHomeRoute } from '../../../codex/codex-pane-account-registry'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth-service'
import type { StablePaneOwner } from '../pane/stable-owner'
import type { PaneSpawnReservation } from '../pane/spawn-reservation'
import type { AdoptStablePaneResult } from '../ipc/spawn-types'
import type { PtyBindingSourceExpectation } from '../../../persistence'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../../../shared/agent-session-host-authority'
import { localProvider } from '../provider/registry'

export type RuntimePtySpawnState = {
  deps: PtyRuntimeControllerDeps
  args: RuntimePtySpawnArgs
  codexHomeLaunchStartedAt: Date | undefined
  codexHomeLaunchStartedSequence: number | undefined
  preAdoptedStablePane: AdoptStablePaneResult | null
  reattachedCodexHomeRoutes: Map<string, CodexPaneHomeRoute | null>
  cwd: string | undefined
  provider: IPtyProvider
  isClaudeLaunch: boolean
  terminalRuntimeOptions: { shellOverride?: string; terminalWindowsWslDistro?: string | null }
  daemonShellOverride: string | undefined
  isDaemonHostSpawn: boolean
  callerRequestedSessionId: string | undefined
  requestedSessionId: string | undefined
  sessionId: string | undefined
  effectiveSessionRelayId: string | undefined
  effectiveSessionAppId: string | undefined
  isNewDaemonSession: boolean
  expectedWslDistro: string | null
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
      }
    | undefined
  env: Record<string, string> | undefined
  requestedAgentTeamsPath: string | undefined
  selectedCodexHomePath: string | null
  codexResumeHomeSelected: boolean
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
  reconciledSnapshotSeq: number | null
  snapshotKittyFlagsCoverReconciledSeq: boolean
  preparedProvisionalExecutionContext: boolean
  releaseWorktreeSpawn: (() => void) | undefined
  reportPtySpawnCommitted: () => void
}

export type RuntimePtySpawnArgs = {
  cols: number
  rows: number
  cwd?: string
  command?: string
  launchAgent?: TuiAgent
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
  connectionId?: string | null
  worktreeId?: string
  preAllocatedHandle?: string
  tabId?: string
  leafId?: string
  sessionId?: string
  isNewSession?: boolean
  persistHostSessionBinding?: boolean
  expectedSourceBinding?: PtyBindingSourceExpectation
  terminalColorQueryReplies?: { foreground?: string; background?: string }
  agentSessionEnsure?: {
    claim: AgentSessionExecutionClaim
    surface: AgentSessionSurfaceBinding
  }
  agentSessionCreateOperationId?: string
  signal?: AbortSignal
  onPtySpawnCommitted?: () => void
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
    preAdoptedStablePane: null,
    reattachedCodexHomeRoutes: new Map(),
    cwd: undefined,
    provider: localProvider,
    isClaudeLaunch: false,
    terminalRuntimeOptions: {},
    daemonShellOverride: undefined,
    isDaemonHostSpawn: false,
    callerRequestedSessionId: undefined,
    requestedSessionId: undefined,
    sessionId: undefined,
    effectiveSessionRelayId: undefined,
    effectiveSessionAppId: undefined,
    isNewDaemonSession: false,
    expectedWslDistro: null,
    codexSelectionTarget: { runtime: 'host' },
    launchCommand: undefined,
    claudeAuth: null,
    shouldPersistHostSessionBinding: false,
    hostSessionBinding: undefined,
    env: undefined,
    requestedAgentTeamsPath: undefined,
    selectedCodexHomePath: null,
    codexResumeHomeSelected: false,
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
    reportPtySpawnCommitted: () => {}
  }
}
