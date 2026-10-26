import { isValidTerminalTabId } from '../../../shared/terminal-tab-id'
import type { AgentSessionClaimedSpawnResult } from '../../../shared/agent-session-host-authority'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { Store, PtyBindingSourceExpectation } from '../../persistence'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { PtyRegistrationClaim } from '../../runtime/runtime-terminal-state-records'
import { markNativeWindowsConptyPty } from '../../runtime/terminal-model-query-authority'
import type { IPtyProvider, PtySpawnResult } from '../../providers/pty-provider-contract'
import type { CodexPaneHomeRoute } from '../../codex/codex-pane-account-registry'
import type { CodexAccountSelectionTarget } from '../../codex-accounts/runtime-selection'
import type { PtySpawnTiming } from './pty-spawn-timing'
import type { CodexHomePtySpawnedLifecycleArgs } from './host-env/types'
import {
  codexReattachedHomeRouteField,
  shouldSkipCodexHomeEnvForWindowsShell
} from './host-env/codex-home'
import { commitAttachedPtySize, type PtyGrid } from './delivery/attached-pty-size'
import { seedTerminalRestoreRecordsFromSpawnResult } from './pane/agent-session-owners'
import { admitProviderReattachLaunchIdentity } from './pane/launch-authority'
import type { ReplacedPaneOwner } from './pane/replaced-pane-owner'
import { admitPtySpawnOwnership, registerPersistedPtySpawn } from './pane/spawn-registration'
import {
  resolvePaneSpawnReservation,
  type PaneSpawnReservation,
  type PaneSpawnReservationResult
} from './pane/spawn-reservation'
import type { StablePaneOwner } from './pane/stable-owner'
import { seedHeadlessTerminalFromSpawnResult } from './pane/terminal-spawn-restore'
import type { RuntimePtySpawnArgs } from './runtime/spawn-state'
import { reportRuntimeResumeOutcome } from './runtime/spawn-commit-response'
import { savePtySpawnPaneBinding, type PtySpawnPaneBinding } from './spawn-commit-binding'
import { publishCommittedPtySpawn, type PtySpawnPaneKeyAliases } from './spawn-commit-publication'

export type PtySpawnCommitState = {
  deps: {
    runtime?: OrcaRuntimeService
    getSettings?: () => GlobalSettings | undefined
    options?: { onCodexHomePtySpawned?: (args: CodexHomePtySpawnedLifecycleArgs) => void }
    sendPtySpawnedToRenderer: (id: string) => void
    transitionSpawnHiddenRendererPtyDeliveryState?: (id: string, hidden: boolean) => void
    syncPtyBackgroundedDelivery?: (id: string, caller: string) => void
  }
  args: Pick<
    RuntimePtySpawnArgs,
    | 'cols'
    | 'rows'
    | 'connectionId'
    | 'worktreeId'
    | 'tabId'
    | 'launchAgent'
    | 'resumeProviderSession'
    | 'onResumeOutcome'
    | 'telemetry'
  >
  result: PtySpawnResult
  provider: IPtyProvider
  cwd: string | undefined
  metadataLeafId: string | null
  pendingRegistrationClaim?: PtyRegistrationClaim
  pendingRegistrationPtyId: string | null
  paneSpawnReservationKey: string | null
  paneSpawnReservation: PaneSpawnReservation | null
  effectiveSessionAppId: string | undefined
  stablePaneOwner: StablePaneOwner | null
  sessionSizeBeforeAttach: PtyGrid | undefined
  isDaemonHostSpawn: boolean
  codexResumeHomeSelected: boolean
  codexResumeUnavailable?: boolean
  selectedCodexHomePath: string | null
  codexSelectionTarget: CodexAccountSelectionTarget
  codexHomeLaunchStartedAt: Date | undefined
  codexHomeLaunchStartedSequence: number | undefined
  /** Before the provider started anything, so no output of this spawn's process predates it. */
  spawnRequestedAt?: number
  reattachedCodexHomeRoutes: Map<string, CodexPaneHomeRoute | null>
  launchCommand: string | undefined
  preSpawnHiddenMarkId: string | null
  replacedPaneOwner?: ReplacedPaneOwner | null
  agentTeamsLeaderHandle?: string | null
  exitedBeforeRegistration?: boolean
}

export type PtySpawnCommitInput<Reply extends PtySpawnResult> = {
  state: PtySpawnCommitState
  nativeWindowsConptySpawn: boolean
  /** Pane key the headless model seeds under. */
  seedPaneKey: string | null
  paneBinding?: PtySpawnPaneBinding
  expectedSourceBinding?: PtyBindingSourceExpectation
  /** A live agent session the host claimed instead of starting one. */
  adoptedAgentSession?: AgentSessionClaimedSpawnResult
  registration: {
    store: Store | undefined
    worktreeId: string | null | undefined
    shellOverride: string | undefined
    rendererLaunchAuthority: { launchToken: string; launchAgent: TuiAgent } | null
  }
  preAllocatedHandle: string | null | undefined
  spawnTiming?: PtySpawnTiming
  /** Validated pane key; serializer readiness, aliases and resume identity read it. */
  paneKey: string | null
  paneKeyAliases?: PtySpawnPaneKeyAliases
  memorySessionId: string | null
  resumeArgvDropped: boolean
  /** Window reports base environment; host reports its assembled environment. */
  codexLaunchEnv: Record<string, string> | undefined
  initiallyHidden: boolean
  /** Renderer-scoped marks refresh here; runtime-owned marks refresh after commit. */
  hiddenDelivery: 'renderer-scoped' | 'runtime-owned'
  /** Drain returns early exit and settles registration; throw leaves cleanup to the runner. */
  earlyExit: 'drain' | 'throw'
  joinPayload: { reservation: PaneSpawnReservationResult; reply: Reply }
}

/** The one commit for a freshly started process, run inside the OpenCode prompt-intent wrapper. */
export function commitPtySpawn<Reply extends PtySpawnResult>(
  input: PtySpawnCommitInput<Reply> & { earlyExit: 'throw' }
): Promise<Reply | Awaited<ReturnType<typeof commitAdoptedAgentSession>>>
export function commitPtySpawn<Reply extends PtySpawnResult>(
  input: PtySpawnCommitInput<Reply>
): Promise<Reply | PtySpawnResult>
export async function commitPtySpawn<Reply extends PtySpawnResult>(
  input: PtySpawnCommitInput<Reply>
): Promise<Reply | PtySpawnResult> {
  const { state } = input
  const { result } = state
  const runtime = state.deps.runtime
  admitPtySpawnOwnership(runtime, result)
  if (input.nativeWindowsConptySpawn) {
    markNativeWindowsConptyPty(result.id)
  }
  // Seed before the first disk await so live output appends to the restored history.
  seedHeadlessTerminalFromSpawnResult(runtime, result, input.seedPaneKey)
  seedTerminalRestoreRecordsFromSpawnResult(runtime, result)
  const providerReattachLaunchIdentity = admitProviderReattachLaunchIdentity(result)
  if (input.adoptedAgentSession) {
    return commitAdoptedAgentSession(
      input,
      input.adoptedAgentSession,
      providerReattachLaunchIdentity
    )
  }
  reportRuntimeResumeOutcome({
    args: state.args,
    result,
    codexResumeUnavailable: state.codexResumeUnavailable,
    codexResumeArgvDropped: input.resumeArgvDropped
  })
  if (input.paneBinding) {
    await savePtySpawnPaneBinding(state, input.paneBinding, state.args.connectionId)
  }
  const { registration } = input
  if (registration.worktreeId) {
    const tabId = state.args.tabId
    const rejectedRegistration = registerPersistedPtySpawn(
      runtime,
      registration.store,
      state.pendingRegistrationClaim,
      result.id,
      registration.worktreeId,
      null,
      // Validate pane identity so throttled mobile creation retains its live PTY surface (#7587).
      typeof tabId === 'string' &&
        isValidTerminalTabId(tabId) &&
        tabId.length <= 512 &&
        state.metadataLeafId !== null
        ? {
            tabId,
            leafId: state.metadataLeafId,
            ...(input.preAllocatedHandle ? { terminalHandle: input.preAllocatedHandle } : {}),
            ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
            ...(registration.rendererLaunchAuthority
              ? { agentLaunchAuthority: registration.rendererLaunchAuthority }
              : {}),
            ...(providerReattachLaunchIdentity ? { providerReattachLaunchIdentity } : {})
          }
        : undefined,
      shouldSkipCodexHomeEnvForWindowsShell(registration.shellOverride, state.cwd)
    )
    if (rejectedRegistration) {
      if (input.earlyExit === 'throw') {
        return await rejectedRegistration
      }
      await rejectedRegistration.catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'agent_session_exited_during_start') {
          throw error
        }
      })
      runtime?.cancelPendingPtyRegistration?.(
        result.id,
        result.incarnationId,
        state.pendingRegistrationClaim
      )
      state.pendingRegistrationPtyId = null
      state.exitedBeforeRegistration = true
      // The renderer drains this incarnation's buffered output and exit without publishing it live.
      return resolvePaneSpawnReservation(
        state.paneSpawnReservationKey,
        state.paneSpawnReservation,
        input.joinPayload.reply
      )
    }
  } else if (input.earlyExit === 'throw') {
    // Worktree-less PTYs have no later surface-registration step to clear admission.
    runtime?.cancelPendingPtyRegistration?.(
      result.id,
      result.incarnationId,
      state.pendingRegistrationClaim
    )
  } else if (state.pendingRegistrationPtyId) {
    runtime?.cancelPendingPtyRegistration?.(
      state.pendingRegistrationPtyId,
      result.incarnationId,
      state.pendingRegistrationClaim
    )
  }
  if (input.earlyExit === 'drain') {
    state.pendingRegistrationPtyId = null
  }
  return publishCommittedPtySpawn(input)
}

function commitAdoptedAgentSession<Reply extends PtySpawnResult>(
  input: PtySpawnCommitInput<Reply>,
  adopted: AgentSessionClaimedSpawnResult,
  providerReattachLaunchIdentity: ReturnType<typeof admitProviderReattachLaunchIdentity>
): PtySpawnResult | Promise<never> {
  const { state } = input
  const { result } = state
  const runtime = state.deps.runtime
  // Adoption proves attach even without the reply flag; size commit and joiners must agree.
  const adoptedResult = { ...result, isReattach: true }
  const { surface } = adopted.owner
  const rejectedRegistration = registerPersistedPtySpawn(
    runtime,
    input.registration.store,
    state.pendingRegistrationClaim,
    result.id,
    surface.worktreeId,
    null,
    {
      tabId: surface.tabId,
      leafId: surface.leafId,
      terminalHandle: surface.terminalHandle,
      ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
      ...(providerReattachLaunchIdentity ? { providerReattachLaunchIdentity } : {})
    }
  )
  if (rejectedRegistration) {
    return rejectedRegistration
  }
  runtime?.noteTerminalSpawnCommit?.(result, input.expectedSourceBinding)
  runtime?.registerPreAllocatedHandleForPty(result.id, surface.terminalHandle)
  state.deps.options?.onCodexHomePtySpawned?.({
    id: result.id,
    codexHomePath: state.selectedCodexHomePath,
    reattached: true,
    startedAt: state.codexHomeLaunchStartedAt,
    startedSequence: state.codexHomeLaunchStartedSequence,
    ...codexReattachedHomeRouteField(state.reattachedCodexHomeRoutes, result.id, true),
    ...(input.codexLaunchEnv ? { launchEnv: input.codexLaunchEnv } : {})
  })
  commitAttachedPtySize({
    result: adoptedResult,
    requested: { cols: state.args.cols, rows: state.args.rows },
    cachedBeforeAttach: state.sessionSizeBeforeAttach,
    reflowHeadlessTerminalToPtyGrid: runtime?.reflowHeadlessTerminalToPtyGrid?.bind(runtime)
  })
  resolvePaneSpawnReservation(
    state.paneSpawnReservationKey,
    state.paneSpawnReservation,
    adoptedResult
  )
  return adoptedResult
}
