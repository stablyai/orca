import type * as Calls from './runtime-host-service-calls'
import type { IPtyProvider } from '../../providers/pty-provider-contract'
import type {
  RuntimePtyWorktreeRecord,
  RuntimeHeadlessTerminal,
  RuntimeVisibleTerminalState,
  RuntimeLeafRecord
} from '../runtime-terminal-state-records'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import type { AgentStatus } from '../../../shared/agent-detection'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { TuiIdleHookTurn } from '../tui-idle-hook-lane'
import type { RuledScreen } from '../screen-input-veto'
import type {
  TerminalHandleRecord,
  TerminalWaiter,
  OrchestrationCompatibilityTerminalAuthority
} from '../runtime-terminal-contracts'
import type { TitleDisplayClear } from '../runtime-worktree-status-projection'
import type { OrchestrationDb } from '../orchestration/db/orchestration-db'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type {
  RuntimeTerminalShow,
  RuntimeTerminalSummary,
  RuntimeTerminalAgentStatus
} from '../../../shared/runtime-terminal-contracts'
import type { RuntimeSyncedLeaf } from '../../../shared/runtime-session-contracts'
import type { readOrchestrationFleetAgentStatusSnapshot } from '../orchestration-fleet-agent-status-snapshot'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'
import type { ProcessedAgentStatusChunk } from '../../../shared/agent-status-osc'
import type { RuntimeTerminalAgentPresenceOptions } from '../runtime-terminal-agent-presence'
import type { resolveTerminalOrchestrationCliCommand } from '../orchestration/cli-command'
import type { OrchestrationMailboxLeaf } from '../orchestration/mailbox-owner'
import type { OrchestrationMailboxPointerSubmitTarget } from '../orchestration/mailbox-pointer-submit'
import type { WriteSettlement } from '../../../shared/pty-write-settlement'
import type { StructuredPointerTarget } from '../orchestration/structured-mailbox-pointer-delivery'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type * as PtyControllerContract from '../runtime-pty-controller-contract'
import type { RuntimeClientEventBus } from '../runtime-client-event-bus'
import type { RuntimeRepoSelector } from '../runtime-repo-selector'
import type { PtyPane, PtyPaneSource } from '../terminal/surface/pty-pane-query'
import type { PtyLaneMailboxTarget } from '../terminal/query/pty-terminal-summary'

export abstract class RuntimeConstructionServices {
  abstract getOrchestrationDb(): OrchestrationDb
  abstract listRepos(): Repo[]
  abstract invalidateResolvedWorktreeCache(): void
  abstract invalidateWorktreeScanCacheForRepo(repoId: string): void
  abstract notifyWorktreesChanged(repoId: string, options?: { invalidateGitScans?: boolean }): void
  protected abstract notifyReposChanged(): void
  protected abstract isPtyKnownExited(ptyId: string): boolean

  abstract getPtyLivenessVerdict(
    ...args: Calls.GetPtyLivenessVerdictArgs
  ): Calls.GetPtyLivenessVerdictResult
  abstract stopTerminalsForWorktree(
    ...args: Calls.StopTerminalsForWorktreeArgs
  ): Calls.StopTerminalsForWorktreeResult
  abstract stopTerminalsForProject(
    ...args: Calls.StopTerminalsForProjectArgs
  ): Calls.StopTerminalsForProjectResult
  abstract resolveOrchestrationWorkerServer(
    ...args: Calls.ResolveOrchestrationWorkerServerArgs
  ): Calls.ResolveOrchestrationWorkerServerResult
  abstract callOrchestrationWorkerServer(
    ...args: Calls.CallOrchestrationWorkerServerArgs
  ): Calls.CallOrchestrationWorkerServerResult
  abstract syncOrchestrationFederatedDispatch(
    ...args: Calls.SyncOrchestrationFederatedDispatchArgs
  ): Calls.SyncOrchestrationFederatedDispatchResult
  abstract retireStructuredAgentSessionTabFromSnapshot(sessionId: string): boolean
  abstract forgetStructuredSessionMail(sessionId: string): void
  abstract getLocalProvider(): IPtyProvider | null
  abstract removeWorktreeMetadataAndHistory(
    ...args: Calls.RemoveWorktreeMetadataAndHistoryArgs
  ): Calls.RemoveWorktreeMetadataAndHistoryResult
  protected abstract workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
    ...args: Calls.WorkspaceSessionWorktreeHasRuntimeOwnedPtyCandidateArgs
  ): Calls.WorkspaceSessionWorktreeHasRuntimeOwnedPtyCandidateResult
  abstract resolveTerminalWorkspaceLaunchScope(
    ...args: Calls.ResolveTerminalWorkspaceLaunchScopeArgs
  ): Calls.ResolveTerminalWorkspaceLaunchScopeResult

  protected abstract handleGraphReloadTimeout(windowId: number): void
  protected abstract flushScheduledMobileSessionTabsChanged(worktreeId: string): void
  protected abstract getMobileSessionWorktreeIdsForPty(ptyId: string): string[]
  abstract touchMobileSessionTabsForWorktree(
    worktreeId: string,
    options?: {
      immediate?: boolean
    }
  ): void
  protected abstract ptysById: Map<string, RuntimePtyWorktreeRecord>
  protected abstract repointPendingMessagesForHandle(handle: string): void
  protected abstract getPtyWriteHostPlatform(ptyId: string): NodeJS.Platform
  protected abstract getPtyAgent(ptyId: string): TerminalAgent | null
  protected abstract getAdoptedPtyExplicitIdleStatus(
    pty: RuntimePtyWorktreeRecord
  ): AgentStatus | null
  protected abstract readTuiIdleHookTurnForPty(
    ptyId: string,
    agent: TuiAgent
  ): TuiIdleHookTurn | null
  protected abstract readLiveTerminalScreenLines(ptyId: string | null | undefined): string[] | null
  protected abstract readCaughtUpRuledScreen(ptyId: string): RuledScreen | null
  protected abstract clearWaitBlockedStamp(ptyId: string): void
  protected abstract readRuledScreen(ptyId: string | null | undefined): RuledScreen | null
  protected abstract headlessTerminals: Map<string, RuntimeHeadlessTerminal>
  protected abstract readHeadlessVisibleTerminalState(
    ptyId: string
  ): Promise<RuntimeVisibleTerminalState | null>
  protected abstract getLeafKey(tabId: string, leafId: string): string
  /** L80: sole reader of a PTY record's tab/pane copies. */
  protected abstract paneOfPty(pty: PtyPaneSource | null | undefined): PtyPane
  protected abstract getLivePtyForHandle(handle: string): {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null
  protected abstract getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  }
  protected abstract getOrchestrationMailboxLeafForHandle(handle: string): OrchestrationMailboxLeaf
  protected abstract getPtyLaneMailboxTarget(leafKey: string): PtyLaneMailboxTarget | null
  protected abstract hasMailboxTerminalHandle(handle: string): boolean
  protected abstract startTuiIdleVisibleReadProbe(
    waiter: TerminalWaiter,
    waiterTimeoutMs: number,
    agent: TuiAgent | null
  ): void
  protected abstract getPtyTitleDisplayClear(
    ptyId: string | null | undefined
  ): TitleDisplayClear | null
  protected abstract flushPendingWaitBlockedCheck(ptyId: string): void
  protected abstract makeDecorativeTitleGateKey(rawTitle: string, normalizedTitle: string): string
  protected abstract refreshTerminalSideEffectConsumerAvailability(): void
  protected abstract resolveNativeChatLaunchDraftOwner(handle: string): {
    tabId: string
    worktreeId: string
  } | null
  protected abstract scheduleMobileSessionTabsChanged(worktreeId: string): void
  protected abstract emitClientEvent: RuntimeClientEventBus['emit']
  protected abstract getOrchestrationDbIfAvailable(): OrchestrationDb | null
  protected abstract listResolvedWorktrees(): Promise<ResolvedWorktree[]>
  abstract showTerminal(handle: string): Promise<RuntimeTerminalShow>
  protected abstract issueHandle(leaf: RuntimeLeafRecord): string
  protected abstract issuePtyHandle(pty: RuntimePtyWorktreeRecord): string
  protected abstract makeRuntimePaneKey(
    leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
  ): string
  abstract getTerminalWorktreeIdForHandle(handle: string): string | null
  abstract getTerminalHandleForPaneKey(paneKey: string): string | null
  protected abstract getPaneKeyForTerminalHandle(handle: string): string | null
  abstract getOrchestrationDispatchAuthority(
    terminalHandle: string
  ): OrchestrationCompatibilityTerminalAuthority | null
  abstract getOrchestrationFleetAgentStatusSnapshot(): ReturnType<
    typeof readOrchestrationFleetAgentStatusSnapshot
  >
  protected abstract assertStableReadyGraph(expectedGraphEpoch: number): void
  protected abstract getValidatedExplicitWorktreeIdSelector(
    selector: string | undefined
  ): string | null
  abstract getExplicitSessionWorktreeIdSelector(selector: string | undefined): string | null
  protected abstract buildResolvedWorktreeFromId(worktreeId: string): ResolvedWorktree | null
  protected abstract listKnownResolvedWorktreesForExplicitTarget(
    targetWorktreeId: string,
    targetWorktree: ResolvedWorktree | null
  ): ResolvedWorktree[]
  protected abstract getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>>
  protected abstract buildTerminalSummary(
    leaf: RuntimeLeafRecord,
    worktreesById: Map<string, ResolvedWorktree>,
    provenLivePtyIds?: ReadonlySet<string> | null
  ): RuntimeTerminalSummary
  protected abstract buildPtyTerminalSummary(
    pty: RuntimePtyWorktreeRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary
  protected abstract getTerminalTopologyRevision(worktreeId: string): number
  protected abstract buildTerminalListHostScope(
    targetWorktreeId: string | null,
    terminals: readonly RuntimeTerminalSummary[],
    worktrees: Iterable<ResolvedWorktree>,
    queriedHostIds: ReadonlySet<ExecutionHostId>
  ): {
    hostIds: ExecutionHostId[]
    omittedHostIds: ExecutionHostId[]
  }
  protected abstract resolveRepoSelector(selector: RuntimeRepoSelector): Promise<Repo>
  protected abstract selectReposBySelector(selector: string): Repo[]
  protected abstract listRepoWorktreesForListing(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult>
  protected abstract listKnownExecutionHostIds(
    additionalHostIds?: Iterable<ExecutionHostId>,
    includeConfiguredHosts?: boolean
  ): Set<ExecutionHostId>
  protected abstract touchMobileSessionSnapshotsForPty(
    ptyId: string,
    options?: {
      immediate?: boolean
    }
  ): void
  protected abstract wslDistroByPtyId: Map<string, string>
  protected abstract runAfterPendingTerminalSideEffectFacts(ptyId: string, run: () => void): void
  protected abstract emitTerminalAgentStatusEvents(
    ptyId: string,
    chunk: Pick<ProcessedAgentStatusChunk, 'payloads'> & Partial<ProcessedAgentStatusChunk>,
    provenance?: {
      origin: 'process'
      yieldsToHookSince: number
    }
  ): void
  protected abstract getPrimaryLeafForPty(ptyId: string): RuntimeLeafRecord | null
  protected abstract readonly agentPromptLifecycleByPtyId: Map<
    string,
    {
      status: AgentStatus | null
      workingSequence: number
      updatedAt: number
    }
  >
  abstract isTerminalRunningAgent(
    handle: string,
    options?: RuntimeTerminalAgentPresenceOptions
  ): Promise<boolean>
  abstract getTerminalProcessIncarnation(handle: string): string | null
  protected abstract controllerKnowsPtyIsLive(ptyId: string): boolean
  protected abstract isLeafPtyProvenAbsent(ptyId: string): Promise<boolean>
  protected abstract checkDeliverySettledAndArmRecheck(leaf: {
    tabId: string
    leafId: string
  }): boolean
  protected abstract isPtyAwaitingUserInput(ptyId: string): boolean
  abstract getTerminalOrchestrationCliCommand(
    handle: string
  ): ReturnType<typeof resolveTerminalOrchestrationCliCommand>
  protected abstract resolveOrchestrationPointerSubmitTarget(
    stagedLeaf: OrchestrationMailboxLeaf,
    ptyId: string
  ): OrchestrationMailboxPointerSubmitTarget | null
  abstract deliverPendingMessagesForHandle(
    handle: string,
    reservedTypes?: ReadonlySet<string>
  ): void
  protected abstract writeOrchestrationPointerPty(
    ptyId: string,
    data: string
  ): WriteSettlement | Promise<WriteSettlement>
  protected abstract resolveStructuredMailboxTarget(
    mailboxHandle: string
  ): StructuredPointerTarget | null
  abstract getTerminalPaneKey(handle: string): string | null
  protected abstract getWorkspaceSessionForWorktree(
    worktreeId: string
  ): WorkspaceSessionState | null
  protected abstract readonly getAgentStatusSnapshotForPaneFn:
    | ((paneKey: string) => AgentStatusIpcPayload[])
    | null
  abstract readonly getAgentStatusSnapshotFn: (() => AgentStatusIpcPayload[]) | null
  protected abstract getTrackedDisplayTitleForPty(ptyId: string): string | null
  protected abstract getLeavesForPty(ptyId: string): RuntimeLeafRecord[]
  abstract notifyMessageArrived(handle: string, messageType?: string): void
  protected abstract resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree>
  protected abstract resolveWorkspaceSelector(
    selector: string,
    options?: { requireUsableFolderPath?: boolean }
  ): Promise<ResolvedWorktree>
  protected abstract refreshPtyWorktreeRecordsWithControllerInventory(
    resolvedWorktrees: ResolvedWorktree[],
    targetWorktreeId?: string | null,
    deadline?: number,
    connectionId?: string | null,
    retryStale?: boolean,
    inventoryOptions?: PtyControllerContract.PtyInventoryRefreshOptions
  ): Promise<PtyControllerContract.PtyControllerInventory | null>
  protected abstract getFreshExplicitAgentStatusForHandle(
    handle: string,
    paneKeyOverride?: string | null
  ): {
    status: NonNullable<RuntimeTerminalAgentStatus['status']>
    updatedAt: number
    stateStartedAt: number
  } | null
}
