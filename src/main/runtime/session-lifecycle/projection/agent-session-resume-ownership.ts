// Who may resume a recorded agent conversation into a pane: the ownership checks and the in-flight
// claim shared by a pane opening over its own record and a targeted resume into a fresh pane.

import { findPaneSleepingRecord } from './pane-sleeping-record'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { OrcaRuntimeWithApplyMobileSessionTabNavigation } from './apply-mobile-session-tab-navigation'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-types'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type {
  MobileTerminalResumeCommand,
  OrcaRuntimeWithResolveMobileSessionTerminalCommand as MobileTerminalStartup
} from '../../terminal/launch/mobile-terminal-startup'
import type { OrcaRuntimeWithMarkPtyLivenessUnverifiable as PtyExitFloor } from '../../terminal/layout/terminal-input-floor'
import type { OrcaRuntimeWithStopTerminalsForWorktree as SessionEditHost } from '../../terminal/stop/worktree-terminal-stop'
import { claimSleepRecordForPane, isUnclaimedRunningSleepRecord } from './sleep-record-pane-claim'
import {
  AgentSessionResumeClaims,
  type AgentSessionResumeClaim,
  type AgentSessionResumeHold,
  type ResumedAgentSession
} from './agent-session-resume-claims'

/** A pane's resume launch, holding the conversation until the pane's spawn binds or releases it. */
export type PaneResumeStartup = MobileTerminalResumeCommand & {
  resumeClaim: AgentSessionResumeClaim
}
export abstract class OrcaRuntimeWithAgentSessionResumeOwnership extends OrcaRuntimeWithApplyMobileSessionTabNavigation {
  protected abstract resolveMobileSessionResumeCommand(
    ...args: Parameters<MobileTerminalStartup['resolveMobileSessionResumeCommand']>
  ): ReturnType<MobileTerminalStartup['resolveMobileSessionResumeCommand']>
  protected abstract commitWorkspaceSessionEdit(
    ...args: Parameters<SessionEditHost['commitWorkspaceSessionEdit']>
  ): ReturnType<SessionEditHost['commitWorkspaceSessionEdit']>
  abstract subscribeToPtyExit(
    ...args: Parameters<PtyExitFloor['subscribeToPtyExit']>
  ): ReturnType<PtyExitFloor['subscribeToPtyExit']>

  protected readonly agentSessionResumeClaims = new AgentSessionResumeClaims({
    reported: (hold) => this.hookStoreReportsResumeHold(hold),
    watchExit: (ptyId, onExit) => this.subscribeToPtyExit(ptyId, onExit),
    watchReports: (onChange) =>
      this.subscribeAgentProviderSessionChangesFn?.(onChange) ?? (() => {})
  })

  /**
   * Whether persistence proves this pane's PTY was deliberately taken down and parked
   * (workspace sleep or completed-agent hibernation) rather than lost and awaiting reconnect.
   * Why: `pending-handle` alone cannot tell those apart — a parked pane publishes it
   * indefinitely — and respawning a parked pane re-launches its agent behind the user.
   * Only an automatic activation consults this; a user opening the tab is the wake gesture.
   */
  protected isDeliberatelyParkedPane(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    // Why: 'live'/'quit' captures describe a pane that was still running, so a reconnect
    // must still mint its replacement PTY (#11542). Only a worktree-owned capture records
    // a deliberate takedown the user did not ask to undo.
    return this.getPaneSleepingAgentRecord(worktreeId, tab)?.origin === 'worktree-sleep'
  }

  /** Whether main resumes this record into its pane. */
  protected isPaneOwnedResumeRecord(record: SleepingAgentSessionRecord): boolean {
    // Why: an originless record predates capture origins and carries no proof of which pane or
    // host wrote it, so it is left (record kept) for the window's legacy cleanup (#29303).
    return (
      record.origin === 'live' || record.origin === 'quit' || record.origin === 'worktree-sleep'
    )
  }

  /**
   * The pane's resume launch: undefined when it owns no record, `{}` (plain shell, record kept)
   * when the record cannot be resumed here or another resume took it.
   */
  protected async resolvePaneOwnedResumeStartup(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): Promise<PaneResumeStartup | Record<string, never> | undefined> {
    const stored = this.getPaneSleepingAgentRecord(worktreeId, tab)
    const record = stored && this.isPaneOwnedResumeRecord(stored) ? stored : null
    if (!record) {
      return undefined
    }
    // Why: nothing here spends the record, so a session another pane also records could be
    // resumed twice (two writers on one transcript), as could one already live in another pane.
    const records = this.getWorkspaceSessionForWorktree(worktreeId)?.sleepingAgentSessionsByPaneKey
    const aliases = this.findPaneSleepingAgentRecord(worktreeId, tab)?.aliases ?? []
    const sharedWithAnotherPane = Object.entries(records ?? {}).some(
      ([paneKey, other]) =>
        other !== record &&
        !aliases.includes(paneKey) &&
        other.agent === record.agent &&
        agentProviderSessionsEqual(record.agent, other.providerSession, record.providerSession)
    )
    // Why before the awaits: the holder checks below then decide for this claim, not for a moment
    // another resumer has since moved past.
    const resumeClaim = sharedWithAnotherPane
      ? null
      : this.agentSessionResumeClaims.claim(record, makePaneKey(tab.parentTabId, tab.leafId))
    if (!resumeClaim) {
      return {}
    }
    const resume = await this.preparePaneOwnedResume(worktreeId, record).catch(() => null)
    if (!resume) {
      resumeClaim.settleFailure(false)
      return {}
    }
    return { ...resume, resumeClaim }
  }

  private async preparePaneOwnedResume(
    worktreeId: string,
    record: SleepingAgentSessionRecord
  ): Promise<MobileTerminalResumeCommand | null> {
    if (
      (await this.isProviderSessionLiveInAnotherPane(record, record.paneKey)) ||
      this.hookStoreNamesAnotherSessionForPane(record)
    ) {
      return null
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    const resume = this.resolveMobileSessionResumeCommand(workspace, record)
    if (!resume) {
      return null
    }
    if (
      isUnclaimedRunningSleepRecord(record) &&
      !(await this.claimSleepRecord(worktreeId, record))
    ) {
      return null
    }
    return resume
  }

  protected claimSleepRecord(
    worktreeId: string,
    record: SleepingAgentSessionRecord
  ): Promise<boolean> {
    const hostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
    return claimSleepRecordForPane((edit) => this.commitWorkspaceSessionEdit(hostId, edit), record)
  }

  /** The hook store names the held session in its pane, from a row since the claim. */
  private hookStoreReportsResumeHold(hold: AgentSessionResumeHold): boolean {
    // Why since the claim: the pane's earlier agent may have named the same session.
    return (this.getAgentProviderSessionSnapshotFn?.() ?? []).some(
      (row) =>
        row.paneKey === hold.paneKey &&
        agentProviderSessionsEqual(hold.agent, row.providerSession, hold.providerSession) &&
        (row.evidenceObservedAt ?? row.receivedAt) >= hold.claimedAt
    )
  }

  /** The host's hook store places this conversation in a pane other than `ownPaneKey`, not proven exited. */
  protected async isProviderSessionLiveInAnotherPane(
    session: ResumedAgentSession,
    ownPaneKey: string | null
  ): Promise<boolean> {
    const otherPaneKeys = new Set(
      (this.getAgentProviderSessionSnapshotFn?.() ?? [])
        .filter(
          (row) =>
            row.paneKey !== ownPaneKey &&
            agentProviderSessionsEqual(session.agent, row.providerSession, session.providerSession)
        )
        .map((row) => row.paneKey)
    )
    // Why: only a proven exit clears a holder; an unverifiable PTY (dropped SSH relay) or one not
    // yet hydrated after a restart may still be writing the transcript.
    const holderPaneKeys = [...otherPaneKeys].filter((paneKey) => this.paneHoldsSession(paneKey))
    if (holderPaneKeys.length === 0) {
      return false
    }
    // Why: a shell can outlive the agent; the hook store's proven exit releases a pane whose PTY lives.
    const verdicts = await Promise.all(
      holderPaneKeys.map((paneKey) =>
        this.checkHookAgentPresenceFn
          ? this.checkHookAgentPresenceFn(paneKey, 0).catch(() => null)
          : Promise.resolve(null)
      )
    )
    return verdicts.some((verdict) => verdict !== 'exited')
  }

  /** The pane moved on to another conversation after the record was saved; the hook store is authoritative. */
  private hookStoreNamesAnotherSessionForPane(record: SleepingAgentSessionRecord): boolean {
    return (this.getAgentProviderSessionRowsForPaneFn?.(record.paneKey) ?? []).some(
      (row) =>
        row.providerSession !== undefined &&
        !agentProviderSessionsEqual(record.agent, row.providerSession, record.providerSession)
    )
  }

  private getPaneSleepingAgentRecord(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): SleepingAgentSessionRecord | null {
    return this.findPaneSleepingAgentRecord(worktreeId, tab)?.record ?? null
  }

  private findPaneSleepingAgentRecord(worktreeId: string, tab: RuntimeMobileSessionTerminalTab) {
    return findPaneSleepingRecord(this.getWorkspaceSessionForWorktree(worktreeId), worktreeId, tab)
  }
}
