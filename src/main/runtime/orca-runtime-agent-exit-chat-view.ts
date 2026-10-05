import { OrcaRuntimeWithAgentExitProof } from './orca-runtime-agent-exit-proof'
import {
  collectAgentExitChatViewCandidates,
  findAgentExitChatViewCandidatesForPty
} from './agent-exit-chat-view-candidates'
import {
  startAgentExitRetirementOperation,
  type AgentExitRetirementOperation
} from './agent-exit-retirement-operation'
import type { AgentExitRun } from './agent-exit-run-registry'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { RuntimeSessionTabPropsResult } from '../../shared/runtime-session-contracts'
import type {
  AgentExitRetirementCondition,
  AgentExitRetirementDisposition
} from '../../shared/agent-exit-retirement'
import { resolveHeadlessAgentExitRetirement } from './headless-agent-exit-retirement'

/**
 * The host's handling of a proven agent exit: each pane that could show the exited run as chat
 * gets one finite, conditional retirement (chat to terminal, a sole pane's hint cleared), fenced by
 * when the end was observed. The mounted desktop pane's own exit route stays; both submit the same
 * conditional retirement, so whichever lands first wins and the other is a no-op.
 */
export class OrcaRuntimeWithAgentExitChatView extends OrcaRuntimeWithAgentExitProof {
  private readonly agentExitRetirementsByPtyId = new Map<string, AgentExitRetirementOperation[]>()
  // Why declared: defined later in the runtime chain, which this split class cannot import.
  declare protected getAvailableAuthoritativeWindow: () => unknown

  /** An agent exit on a headless host: one session write and one snapshot, while it still holds. */
  protected retireHeadlessAgentExitChat(
    worktreeId: string,
    parentTabId: string,
    condition: AgentExitRetirementCondition
  ): AgentExitRetirementDisposition {
    const resolved = resolveHeadlessAgentExitRetirement({
      session: this.getWorkspaceSessionForWorktree(worktreeId),
      worktreeId,
      parentTabId,
      condition,
      stamp: this.headlessPresentationStamps.read(worktreeId, parentTabId),
      // Why the published row's PTY: a client's token was minted from that same row.
      tokenFor: () =>
        this.headlessPresentationStamps.token(
          worktreeId,
          parentTabId,
          this.readPublishedPaneBinding(worktreeId, parentTabId, condition.leafId)
        )
    })
    if (resolved.props) {
      this.persistHeadlessSessionTabProps(worktreeId, parentTabId, resolved.props)
      this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, parentTabId, resolved.props)
    }
    return resolved.disposition
  }

  /** One conditional exit retirement on whichever side owns the tab's committed pair. */
  protected async retireAgentExitChatOnOwner(
    worktreeId: string,
    parentTabId: string,
    condition: AgentExitRetirementCondition
  ): Promise<AgentExitRetirementDisposition> {
    if (!this.getAvailableAuthoritativeWindow()) {
      return this.retireHeadlessAgentExitChat(worktreeId, parentTabId, condition)
    }
    const retire = this.notifier?.retireAgentExitChatView
    if (!retire) {
      throw new Error('runtime_unavailable')
    }
    return retire.call(this.notifier, worktreeId, parentTabId, condition)
  }

  /** A paired client's observed exit, fenced by the token it held when it saw the exit. */
  protected async retireObservedAgentExitChat(
    worktreeId: string,
    parentTabId: string,
    condition: AgentExitRetirementCondition
  ): Promise<RuntimeSessionTabPropsResult> {
    const agentExitDisposition = await this.retireAgentExitChatOnOwner(
      worktreeId,
      parentTabId,
      condition
    )
    return {
      updated: true,
      chatView: this.readMobileSessionTabChatView(worktreeId, parentTabId),
      agentExitDisposition
    }
  }

  /** The title showed the agent exit: the legacy fact keeps its own rules; this only looks. */
  protected confirmPtyAgentExit(
    ptyId: string,
    recoverCompletedHook = false,
    observedAtMs = Date.now()
  ): void {
    super.confirmPtyAgentExit(ptyId, recoverCompletedHook, observedAtMs)
    if (!recoverCompletedHook) {
      this.nudgeAgentExitCheck(ptyId)
    }
  }

  protected storeMobileSessionSnapshot(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    const stamped = super.storeMobileSessionSnapshot(
      worktreeId,
      this.getAvailableAuthoritativeWindow()
        ? snapshot
        : this.withHeadlessPresentationTokens(worktreeId, snapshot)
    )
    // Why: a newly published chat pane may be the first moment its agent is worth measuring.
    for (const candidate of collectAgentExitChatViewCandidates([[worktreeId, stamped]])) {
      if (this.needsAgentIdentity(candidate.ptyId)) {
        this.startAgentIdentityDiscovery(candidate.ptyId)
      }
    }
    this.scheduleAgentPresenceTick()
    return stamped
  }

  private withHeadlessPresentationTokens(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    return {
      ...snapshot,
      tabs: snapshot.tabs.map((tab) =>
        tab.type === 'terminal'
          ? {
              ...tab,
              presentationToken: this.headlessPresentationStamps.token(
                worktreeId,
                tab.parentTabId,
                tab.ptyId
              )
            }
          : tab
      )
    }
  }

  private readPublishedPaneBinding(
    worktreeId: string,
    parentTabId: string,
    leafId: string
  ): string | null | undefined {
    const row = this.mobileSessionTabsByWorktree
      .get(worktreeId)
      ?.tabs.find(
        (tab) => tab.type === 'terminal' && tab.parentTabId === parentTabId && tab.leafId === leafId
      )
    return row?.type === 'terminal' ? row.ptyId : undefined
  }

  protected isAgentExitChatCandidate(ptyId: string): boolean {
    return (
      findAgentExitChatViewCandidatesForPty(this.mobileSessionTabsByWorktree.entries(), ptyId)
        .length > 0
    )
  }

  protected forgetAgentExitRun(ptyId: string): void {
    super.forgetAgentExitRun(ptyId)
    for (const operation of this.agentExitRetirementsByPtyId.get(ptyId) ?? []) {
      operation.cancel()
    }
    this.agentExitRetirementsByPtyId.delete(ptyId)
  }

  protected onAgentRunExitProven(run: AgentExitRun, observedAtMs: number): void {
    const stillOwed = (): boolean => {
      const pty = this.ptysById.get(run.ptyId)
      return Boolean(
        this.agentExitRuns.isCurrent(run) &&
        pty?.connected &&
        (pty.incarnationId ?? null) === run.incarnationId
      )
    }
    if (!stillOwed()) {
      return
    }
    // Why: the hook store records the ended owner itself when its probe agrees.
    void this.recheckHookAgentPresenceForPty(run.ptyId)
    this.retirePtyAgentLaunchAuthority(run.ptyId)
    for (const operation of this.agentExitRetirementsByPtyId.get(run.ptyId) ?? []) {
      operation.cancel()
    }
    const operations = findAgentExitChatViewCandidatesForPty(
      this.mobileSessionTabsByWorktree.entries(),
      run.ptyId
    ).map((candidate) =>
      startAgentExitRetirementOperation({
        attempt: () =>
          this.retireAgentExitChatOnOwner(candidate.worktreeId, candidate.parentTabId, {
            leafId: candidate.leafId,
            ptyId: run.ptyId,
            observedAtMs
          }),
        stillOwed,
        onSettled: (outcome, error) => {
          if (outcome === 'failed') {
            console.warn('[native-chat] could not retire an exited agent chat view', error)
          }
        }
      })
    )
    this.agentExitRetirementsByPtyId.set(run.ptyId, operations)
  }
}
