// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithControllerKnowsPtyIsLive } from './orca-runtime-controller-knows-pty-is-live'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-types'
import type { RuntimeTerminalAgentStatusSnapshot } from './runtime-terminal-agent-status-query'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { hasCompatibleAgentTitleIdentity } from '../../shared/agent-title-owner'
import type { PtyForegroundProcessRead } from './runtime-terminal-contracts'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type {
  AgentPromptActivity,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import { readAgentPromptWaitText } from './agent-prompt-submission-verification'
import type { AgentStatus } from '../../shared/agent-detection'

export class OrcaRuntimeWithSerializeAgentPromptSubmission extends OrcaRuntimeWithControllerKnowsPtyIsLive {
  protected async serializeAgentPromptSubmission<T>(
    ptyId: string,
    generation: number,
    submit: () => Promise<T>
  ): Promise<T> {
    const queueKey = `${ptyId}\u0000${generation}`
    const previous = this.agentPromptSubmissionTailByPtyId.get(queueKey) ?? Promise.resolve()
    const submission = previous.catch(() => undefined).then(submit)
    const tail = submission.then(
      () => undefined,
      () => undefined
    )
    this.agentPromptSubmissionTailByPtyId.set(queueKey, tail)
    try {
      return await submission
    } finally {
      if (this.agentPromptSubmissionTailByPtyId.get(queueKey) === tail) {
        this.agentPromptSubmissionTailByPtyId.delete(queueKey)
      }
    }
  }

  getTerminalAgentStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    return this.terminalAgentStatus.getStatus(handle)
  }

  protected getTerminalAgentStatusPtyId(handle: string): string {
    return this.terminalAgentStatus.getPtyId(handle)
  }

  protected getTerminalAgentStatusSnapshot(
    handle: string,
    expectedPtyId: string,
    waitTextOverride?: string
  ): RuntimeTerminalAgentStatusSnapshot {
    const snapshot = this.terminalAgentStatus.getSnapshot(handle, expectedPtyId)
    return waitTextOverride === undefined ? snapshot : { ...snapshot, waitText: waitTextOverride }
  }

  protected shouldDelayPtyBackedMobileSnapshotForForegroundAgent(
    pty: RuntimePtyWorktreeRecord,
    title: string
  ): boolean {
    return (
      !pty.launchAgent && pty.foregroundAgent === null && hasCompatibleAgentTitleIdentity(title)
    )
  }

  protected readPtyForegroundProcessFromController(
    ptyId: string,
    afterTitleObservation = 0
  ): Promise<PtyForegroundProcessRead> | null {
    return this.ptyForegroundAgent.read(ptyId, afterTitleObservation)
  }

  protected confirmPtyAgentExit(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    const titleObservedAt = pty?.lastOscTitleAt ?? null
    const foregroundRead = this.readPtyForegroundProcessFromController(ptyId, titleObservedAt ?? 0)
    if (!pty?.connected || !foregroundRead) {
      this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
      return
    }
    void foregroundRead.then((result) => {
      const current = this.ptysById.get(ptyId)
      if (current !== pty || !current.connected) {
        return
      }
      if (current.lastOscTitleAt !== titleObservedAt && current.lastAgentStatus !== null) {
        return
      }
      if (
        result.controller === this.ptyController &&
        result.available &&
        recognizeAgentProcess(result.process) !== null
      ) {
        const restoredStatus = this.ptyTitleTrackersByPtyId
          .get(ptyId)
          ?.tracker.restoreLastAgentExit()
        if (restoredStatus !== null && restoredStatus !== undefined) {
          current.lastAgentStatus = restoredStatus
          for (const leaf of this.getLeavesForPty(ptyId)) {
            if (leaf.lastAgentStatus !== null) {
              continue
            }
            // Why: the foreground agent disproved the neutral title's exit signal; keep runtime delivery state aligned with the restored tracker.
            leaf.lastAgentStatus = restoredStatus
            if (restoredStatus === 'idle') {
              this.deliverPendingMessagesForLeaf(leaf)
            }
          }
        }
        return
      }
      this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
    })
  }

  /**
   * Schedules an asynchronous query to check which agent process is currently
   * running in the foreground of a PTY.
   */
  protected refreshPtyForegroundAgent(ptyId: string): void {
    void this.ptyForegroundAgent.refresh(ptyId)
  }

  protected getPendingForegroundAgentRefreshForTitle(
    ptyId: string,
    titleObservedAt: number
  ): Promise<boolean> | undefined {
    return this.ptyForegroundAgent.getPending(ptyId, titleObservedAt)
  }

  protected delayPtyBackedMobileSnapshotForForegroundAgent(
    ptyId: string,
    titleObservedAt: number,
    foregroundRefresh: Promise<boolean>
  ): void {
    this.ptyForegroundAgent.delaySnapshot(ptyId, titleObservedAt, foregroundRefresh)
  }

  protected getFreshExplicitAgentStatusForHandle(
    handle: string,
    paneKeyOverride?: string | null
  ): {
    status: NonNullable<RuntimeTerminalAgentStatus['status']>
    updatedAt: number
    stateStartedAt: number
  } | null {
    return this.agentRows.getFreshExplicit({
      handle,
      paneKey: paneKeyOverride ?? this.getPaneKeyForTerminalHandle(handle),
      hookRows: this.getAgentStatusSnapshotFn?.() ?? []
    })
  }

  protected getAgentPromptActivity(
    handle: string,
    ptyId: string,
    waitTextCache?: AgentPromptWaitTextCache
  ): AgentPromptActivity {
    this.assertLiveTerminalHandleTargetsPty(handle, ptyId)
    const outputSequence = this.getPtyOutputSequence(ptyId)
    const explicitCandidate = this.getFreshExplicitAgentStatusForHandle(handle)
    const explicitFloor = this.agentPromptExplicitStatusFloorByPtyId.get(ptyId)
    const explicit =
      explicitCandidate &&
      (explicitFloor === undefined || explicitCandidate.updatedAt > explicitFloor)
        ? explicitCandidate
        : null
    const lifecycle = this.agentPromptLifecycleByPtyId.get(ptyId)
    const ptyStatus =
      lifecycle || explicitFloor === undefined
        ? (this.ptysById.get(ptyId)?.lastAgentStatus ?? null)
        : null
    const lifecycleIsNewer =
      lifecycle &&
      (!explicit ||
        lifecycle.updatedAt > explicit.updatedAt ||
        (lifecycle.updatedAt === explicit.updatedAt && lifecycle.status === 'permission'))
    const waitText = waitTextCache
      ? readAgentPromptWaitText(
          waitTextCache,
          outputSequence,
          () => this.getTerminalAgentStatusSnapshot(handle, ptyId).waitText
        )
      : undefined
    const terminal = this.getTerminalAgentStatusSnapshot(handle, ptyId, waitText)
    const status = this.hasAuthoritativeTerminalWaitPermission(terminal, explicit, lifecycle)
      ? 'permission'
      : lifecycleIsNewer
        ? lifecycle.status
        : (explicit?.status ?? ptyStatus ?? null)
    return {
      agent: this.getPtyAgent(ptyId),
      generation: this.getPtyLifecycleGeneration(ptyId),
      permissionSequence: this.agentPromptPermissionSequenceByPtyId.get(ptyId) ?? 0,
      workingSequence: lifecycle?.workingSequence ?? 0,
      explicitWorkingStartedAt: explicit?.status === 'working' ? explicit.stateStartedAt : null,
      terminalWorkingSequence: this.agentPromptTerminalWorkingSequenceByPtyId.get(ptyId) ?? 0,
      outputSequence,
      status
    }
  }

  protected hasAuthoritativeTerminalWaitPermission(
    terminal: RuntimeTerminalAgentStatusSnapshot,
    explicitStatus: { status: AgentStatus; updatedAt: number } | null,
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  ): boolean {
    return (
      this.resolveAuthoritativeTerminalWaitPermission(terminal, explicitStatus, lifecycle) !== null
    )
  }
}
