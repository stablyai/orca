// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { selectFreshExplicitAgentStatus } from './runtime-hook-agent-row-selection'
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

  getTerminalAgentStatus(
    handle: string,
    options?: { confirmForeground?: boolean }
  ): Promise<RuntimeTerminalAgentStatus> {
    return this.terminalAgentStatus.getStatus(handle, options)
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

  protected async recheckHookAgentPresenceForPty(
    ptyId: string
  ): Promise<'live' | 'unverifiable' | 'exited' | null> {
    if (!this.checkHookAgentPresenceFn) {
      return null
    }
    const verdicts = await Promise.all(
      Array.from(this.collectAgentStatusPaneKeysForPty(ptyId), (paneKey) =>
        this.checkHookAgentPresenceFn(paneKey)
      )
    )
    if (verdicts.includes('live')) {
      return 'live'
    }
    if (verdicts.includes('unverifiable')) {
      return 'unverifiable'
    }
    return verdicts.includes('exited') ? 'exited' : null
  }

  protected confirmPtyAgentExit(ptyId: string, recoverCompletedHook = false): void {
    const current = this.ptysById.get(ptyId)
    const incarnation = current?.incarnationId
    void this.recheckHookAgentPresenceForPty(ptyId).then((verdict) => {
      if (this.ptysById.get(ptyId) !== current || current?.incarnationId !== incarnation) {
        return
      }
      // Why: without an identified owner (null) the foreground read keeps today's rules; with one
      // whose process cannot be checked right now, silence from that read is never an exit.
      if (verdict === null || verdict === 'unverifiable') {
        this.confirmLegacyPtyAgentExit(ptyId, recoverCompletedHook, verdict === 'unverifiable')
      } else if (verdict === 'exited' && !recoverCompletedHook) {
        this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
      } else if (verdict === 'live') {
        this.restoreDisprovedAgentExit(ptyId)
      } else {
        this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.restoreLastAgentExit()
      }
    })
  }

  private restoreDisprovedAgentExit(ptyId: string, confirmedStatus?: 'idle'): void {
    const current = this.ptysById.get(ptyId)
    const restoredStatus = this.ptyTitleTrackersByPtyId
      .get(ptyId)
      ?.tracker.restoreLastAgentExit(confirmedStatus)
    if (!current || restoredStatus === null || restoredStatus === undefined) {
      return
    }
    current.lastAgentStatus = restoredStatus
    if (restoredStatus === 'idle') {
      this.resolvePtyTuiIdleWaiters(current, ptyId)
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      if (leaf.lastAgentStatus !== null) {
        continue
      }
      // Why: the live agent disproved the neutral title's exit signal; keep runtime delivery state aligned with the restored tracker.
      leaf.lastAgentStatus = restoredStatus
      if (restoredStatus === 'idle') {
        this.resolveTuiIdleWaiters(leaf)
        // Why gated like every other delivery edge: a neutral-title restoration can
        // reinstate `idle` from a name-only title, which is not evidence a turn ended.
        if (this.checkDeliverySettledAndArmRecheck(leaf)) {
          this.deliverPendingMessagesForLeaf(leaf)
        }
      }
    }
  }

  private confirmLegacyPtyAgentExit(
    ptyId: string,
    recoverCompletedHook: boolean,
    keepOnSilence: boolean
  ): void {
    const pty = this.ptysById.get(ptyId)
    const handle = this.handleByPtyId.get(ptyId)
    if (
      recoverCompletedHook &&
      (!handle || this.getFreshExplicitAgentStatusForPty(handle, ptyId)?.status !== 'idle')
    ) {
      return
    }
    const incarnationId = pty?.incarnationId
    const generation = recoverCompletedHook ? this.getPtyLifecycleGeneration(ptyId) : null
    const titleObservedAt = pty?.lastOscTitleAt ?? null
    const foregroundRead = this.readPtyForegroundProcessFromController(ptyId, titleObservedAt ?? 0)
    if (!pty?.connected || !foregroundRead) {
      if (keepOnSilence) {
        this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.restoreLastAgentExit()
      } else if (!recoverCompletedHook) {
        this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
      }
      return
    }
    void foregroundRead.then((result) => {
      const current = this.ptysById.get(ptyId)
      if (
        current !== pty ||
        !current.connected ||
        current.incarnationId !== incarnationId ||
        (recoverCompletedHook && this.getPtyLifecycleGeneration(ptyId) !== generation)
      ) {
        return
      }
      if (current.lastOscTitleAt !== titleObservedAt && current.lastAgentStatus !== null) {
        return
      }
      if (
        recoverCompletedHook &&
        (!current.lastAgentStatusObservedLive ||
          this.getFreshExplicitAgentStatusForPty(handle, ptyId)?.status !== 'idle')
      ) {
        return
      }
      if (recoverCompletedHook && current.lastOscTitleAt !== titleObservedAt) {
        this.confirmPtyAgentExit(ptyId, true)
        return
      }
      if (
        result.controller === this.ptyController &&
        result.available &&
        recognizeAgentProcess(result.process) !== null
      ) {
        // Codex's final native spinner can arrive after its done hook, then clear to the cwd.
        const confirmedStatus =
          recoverCompletedHook && recognizeAgentProcess(result.process)?.agent === 'codex'
            ? 'idle'
            : undefined
        this.restoreDisprovedAgentExit(ptyId, confirmedStatus)
        return
      }
      const answered =
        result.controller === this.ptyController &&
        result.available &&
        typeof result.process === 'string'
      if (!keepOnSilence || answered) {
        if (!recoverCompletedHook) {
          this.recordTerminalSideEffectFact(ptyId, { kind: 'agent-exited' })
        }
      } else {
        this.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.restoreLastAgentExit()
      }
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
    return selectFreshExplicitAgentStatus({
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
    const explicit = this.getFreshExplicitAgentStatusForPty(handle, ptyId)
    const explicitFloor = this.agentPromptExplicitStatusFloorByPtyId.get(ptyId)
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
      generation: this.getPtyLifecycleGeneration(ptyId),
      permissionSequence: this.agentPromptPermissionSequenceByPtyId.get(ptyId) ?? 0,
      workingSequence: lifecycle?.workingSequence ?? 0,
      explicitWorkingStartedAt: explicit?.status === 'working' ? explicit.stateStartedAt : null,
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

  protected getFreshExplicitAgentStatusForPty(handle: string, ptyId: string) {
    const explicit = this.getFreshExplicitAgentStatusForHandle(handle)
    const floor = this.agentPromptExplicitStatusFloorByPtyId.get(ptyId)
    return explicit && (floor === undefined || explicit.updatedAt > floor) ? explicit : null
  }
}
