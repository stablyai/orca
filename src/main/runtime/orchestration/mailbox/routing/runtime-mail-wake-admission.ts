import type { SleptMailboxWake } from './slept-mailbox-wake'
import { mailWakeObligation } from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import type { MailboxDeliveryHold } from '../delivery-hold/mailbox-delivery-hold'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from '../../../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { RuntimePtyWorktreeRecord } from '../../../terminal/records/runtime-terminal-state-records'
import type { MailWakeInvocations } from './mail-wake-invocations'

export abstract class RuntimeMailWakeAdmission extends OrcaRuntimeWithPruneMobileSessionTabGroupLayout {
  protected abstract readonly mailWakeInvocations: MailWakeInvocations
  protected abstract hasSleepingMailForPane(paneKey: string): boolean
  protected abstract sleepingMailRecord(paneKey: string): SleepingAgentSessionRecord | null
  protected abstract readonly sleptMailboxWake: SleptMailboxWake
  protected abstract watchSleepingMail(): void
  protected abstract getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null
  async readSleepingMailHold(mailbox: string): Promise<MailboxDeliveryHold | null> {
    this.watchSleepingMail()
    const record = this.sleptMailboxWake.batch(mailbox)?.record
    if (!record || !mailWakeObligation(record)) {
      return null
    }
    const attempt = record.mailWake?.attempt
    const matchingAttempt = () => {
      const pty = this.getPtyRecordForPaneKey(record.paneKey)
      return (
        !!attempt &&
        pty?.connected === true &&
        pty.ptyId === attempt.ptyId &&
        pty.incarnationId === attempt.incarnationId &&
        pty.launchToken === attempt.launchToken &&
        pty.launchIncarnationId === attempt.incarnationId &&
        pty.worktreeId === record.worktreeId &&
        pty.connectionId === (record.connectionId ?? null) &&
        this.terminalRunFacts.readProcessStartedAt(attempt.ptyId, attempt.incarnationId) !== null
      )
    }
    const foreground =
      attempt && matchingAttempt()
        ? await this.readLaunchedAgentForeground(attempt.ptyId, record.agent)
        : 'unknown'
    const current = matchingAttempt() && this.sleepingMailRecord(record.paneKey) === record
    const ended = this.mailWakeInvocations.ended(record)
    const liveShell = current && ended && foreground === 'shell'
    return {
      kind: 'asleep',
      waking:
        mailWakeObligation(record) === 'automatic' && !this.sleptMailboxWake.failedToWake(record),
      resuming: current && !ended && foreground === 'agent',
      agentName: TUI_AGENT_DISPLAY_NAMES[record.agent],
      openTab: record.restoreOnTabOpenOnly === true,
      failed: this.sleptMailboxWake.failedToWake(record),
      liveShell,
      workspaceName: this.resolvedWorktrees
        .peek()
        ?.worktrees.find((row) => row.id === record.worktreeId)?.displayName
    }
  }

  /** Mail that waited on a restoring window can wake its slept pane once the window is ready. */
  override markGraphReady(windowId: number): void {
    const wasReady = this.graphStatus === 'ready'
    super.markGraphReady(windowId)
    if (!wasReady && this.graphStatus === 'ready') {
      queueMicrotask(() => this.retrySleptMailboxWakes())
    }
  }
}
