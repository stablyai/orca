import type { PtySpawnSizeSeed } from '../spawn-options-assembly'
import type { StartupCwdFallback } from '../../../../shared/startup-cwd-fallback'
import type { PtyRegistrationClaim } from '../../../runtime/runtime-terminal-state-records'
import type { PaneSpawnOperation } from '../pane/pane-spawn-operation'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../../../providers/pty-provider-contract'
import type { CodexPaneHomeRoute } from '../../../codex/codex-pane-account-registry'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { ResumeSpawnAdmission } from '../host-env/saved-resume-admission'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth-service'
import type { PtySpawnTiming } from '../pty-spawn-timing'
import { createPtySpawnTiming } from '../pty-spawn-timing'
import { noCodexResumeLaunch, type CodexResumeLaunch } from '../host-env/codex-resume'
import type { StablePaneOwner } from '../pane/stable-owner'
import type { PaneSpawnReservation } from '../pane/spawn-reservation'
import type { ReplacedPaneOwner } from '../pane/replaced-pane-owner'
import { localProvider } from '../provider/registry'
import type { AdoptStablePaneResult, PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import type { PaneAgentLaunch } from './spawn-agent-launch-end'

export type PtyIpcSpawnState = {
  deps: PtySpawnIpcDeps
  args: PtySpawnIpcArgs
  spawnTiming: PtySpawnTiming
  codexHomeLaunchStartedAt: Date | undefined
  codexHomeLaunchStartedSequence: number | undefined
  spawnRequestedAt: number
  reattachedCodexHomeRoutes: Map<string, CodexPaneHomeRoute | null>
  cwd: string | undefined
  prevalidatedCwd: string | undefined
  requestedCwd: string | undefined
  correctStartupCwd?: string
  startupCwdFallback: StartupCwdFallback | undefined
  earlyStablePaneOwner: StablePaneOwner | null
  earlyWorktreeId: string | undefined
  paneSpawnReservationKey: string | null
  paneSpawnReservation: PaneSpawnReservation | null
  replacedPaneOwner: ReplacedPaneOwner | null
  finishTerminalInstall: () => void
  result: PtySpawnResult
  paneSpawnOperation?: PaneSpawnOperation
  stablePaneOwner: StablePaneOwner | null
  stablePaneBindingPersisted: boolean
  rejectedRegistrationCandidate: PtySpawnResult | null
  pendingRegistrationPtyId: string | null
  pendingRegistrationClaim?: PtyRegistrationClaim
  provedSnapshotSeq: number | undefined
  preparedProvisionalExecutionContext: boolean
  releaseWorktreeSpawn: (() => void) | undefined
  provider: IPtyProvider
  preAdoptedStablePane: AdoptStablePaneResult | null
  paneAgentLaunch: PaneAgentLaunch | null
  isClaudeLaunch: boolean
  claudeAuth: ClaudeRuntimeAuthPreparation | null
  terminalRuntimeOptions: {
    shellOverride?: string
    terminalWindowsWslDistro?: string | null
  }
  isDaemonHostSpawn: boolean
  ownsNewIncarnation: boolean
  effectiveSessionId: string | undefined
  effectiveSessionAppId: string | undefined
  expectedWslDistro: string | null
  wslHoldReadAnchor: number | undefined
  baseEnv: Record<string, string> | undefined
  effectiveLaunchConfig: SleepingAgentLaunchConfig | undefined
  preAllocatedHandle: string | null
  /** Leader handle this spawn allocated Agent Teams state for; must be released if the spawn is abandoned. */
  agentTeamsLeaderHandle: string | null
  requestedAgentTeamsPath: string | undefined
  agentTeamsEnvToDelete: string[] | undefined
  stablePaneKey: string | null
  verifiedLeafId: string | null
  metadataLeafId: string | null
  metadataPaneKey: string | null
  legacySpawnPaneKey: { tabId: string; numericPaneId: string; paneKey: string } | null
  opaqueRemintedSpawnPaneKey: string | null
  migrationUnsupportedPaneKey: string | null
  reservationPaneKey: string | null
  validatedPaneKey: string | null
  validatedLeafId: string | null
  effectiveShellOverride: string | undefined
  nativeWindowsConptySpawn: boolean
  codexSelectionTarget: CodexAccountSelectionTarget
  codexResumeLaunch: CodexResumeLaunch
  /** The host's verdict on the spawn's resume; a refused one starts the pane's plain shell. */
  resumeAdmission: ResumeSpawnAdmission | null
  launchCommand: string | undefined
  env: Record<string, string> | undefined
  selectedCodexHomePath: string | null
  spawnEnv: Record<string, string> | undefined
  spawnOptions: PtySpawnOptions
  combinedEnvToDelete: string[] | undefined
  skipCodexHomeEnv: boolean
  stripInheritedOrcaCodexHome: boolean
  codexResumeHomeSelected: boolean
  provisionalPtySize: PtySpawnSizeSeed | undefined
  initiallyHidden: boolean
  preSpawnHiddenMarkId: string | null
}

export function createPtyIpcSpawnState(
  deps: PtySpawnIpcDeps,
  args: PtySpawnIpcArgs
): PtyIpcSpawnState {
  return {
    deps,
    args,
    spawnTiming: createPtySpawnTiming(),
    codexHomeLaunchStartedAt: undefined,
    codexHomeLaunchStartedSequence: undefined,
    spawnRequestedAt: Date.now(),
    reattachedCodexHomeRoutes: new Map(),
    cwd: undefined,
    prevalidatedCwd: undefined,
    requestedCwd: undefined,
    startupCwdFallback: undefined,
    earlyStablePaneOwner: null,
    earlyWorktreeId: undefined,
    paneSpawnReservationKey: null,
    paneSpawnReservation: null,
    replacedPaneOwner: null,
    finishTerminalInstall: () => {},
    result: { id: '' },
    stablePaneOwner: null,
    stablePaneBindingPersisted: false,
    rejectedRegistrationCandidate: null,
    pendingRegistrationPtyId: null,
    provedSnapshotSeq: undefined,
    preparedProvisionalExecutionContext: false,
    releaseWorktreeSpawn: undefined,
    provider: localProvider,
    preAdoptedStablePane: null,
    paneAgentLaunch: null,
    isClaudeLaunch: false,
    claudeAuth: null,
    terminalRuntimeOptions: {},
    isDaemonHostSpawn: false,
    ownsNewIncarnation: false,
    effectiveSessionId: undefined,
    effectiveSessionAppId: undefined,
    expectedWslDistro: null,
    wslHoldReadAnchor: undefined,
    baseEnv: undefined,
    effectiveLaunchConfig: undefined,
    preAllocatedHandle: null,
    agentTeamsLeaderHandle: null,
    requestedAgentTeamsPath: undefined,
    agentTeamsEnvToDelete: undefined,
    stablePaneKey: null,
    verifiedLeafId: null,
    metadataLeafId: null,
    metadataPaneKey: null,
    legacySpawnPaneKey: null,
    opaqueRemintedSpawnPaneKey: null,
    migrationUnsupportedPaneKey: null,
    reservationPaneKey: null,
    validatedPaneKey: null,
    validatedLeafId: null,
    effectiveShellOverride: undefined,
    nativeWindowsConptySpawn: false,
    codexSelectionTarget: { runtime: 'host' },
    codexResumeLaunch: noCodexResumeLaunch(undefined),
    resumeAdmission: null,
    launchCommand: undefined,
    env: undefined,
    selectedCodexHomePath: null,
    spawnEnv: undefined,
    spawnOptions: { cols: args.cols, rows: args.rows },
    combinedEnvToDelete: undefined,
    skipCodexHomeEnv: false,
    stripInheritedOrcaCodexHome: false,
    codexResumeHomeSelected: false,
    provisionalPtySize: undefined,
    initiallyHidden: false,
    preSpawnHiddenMarkId: null
  }
}
