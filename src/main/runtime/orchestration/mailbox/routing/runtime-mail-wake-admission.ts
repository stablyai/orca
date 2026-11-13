import type { SleptMailboxWake } from './slept-mailbox-wake'
import { mailWakeObligation } from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import type { MailboxDeliveryHold } from '../delivery-hold/mailbox-delivery-hold'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from '../../../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type {
  RestoredPane,
  RestoredPaneTrigger
} from '../../../terminal/recovery/restored-pane-start'
import type { RuntimePtyWorktreeRecord } from '../../../terminal/records/runtime-terminal-state-records'
import type { MailWakeInvocations } from './mail-wake-invocations'
import { admitsMailWakeRetry } from './mail-wake-retry-admission'

export abstract class RuntimeMailWakeAdmission extends OrcaRuntimeWithPruneMobileSessionTabGroupLayout {
  protected abstract readonly mailWakeInvocations: MailWakeInvocations
  protected abstract hasSleepingMailForPane(paneKey: string): boolean
  protected abstract sleepingMailRecord(paneKey: string): SleepingAgentSessionRecord | null
  protected abstract readonly sleptMailboxWake: SleptMailboxWake
  protected abstract watchSleepingMail(): void
  protected abstract getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null
  protected async admitFailedMailWake(
    pane: RestoredPane,
    trigger: RestoredPaneTrigger
  ): Promise<boolean> {
    const record = this.sleepingMailRecord(`${pane.tabId}:${pane.leafId}`)
    const attempt = record?.mailWake?.attempt
    const retry = trigger.retryMailWake
    if (
      !retry ||
      !record ||
      !attempt ||
      retry?.id !== record.mailWake?.id ||
      retry.ptyId !== attempt.ptyId ||
      retry.incarnationId !== attempt.incarnationId
    ) {
      return false
    }
    const owns = (ptyId: string, incarnationId: string) => {
      const pty = this.getPtyRecordForPaneKey(record.paneKey)
      return (
        pty?.connected === true &&
        pty.ptyId === ptyId &&
        pty.incarnationId === incarnationId &&
        pty.launchToken === attempt.launchToken &&
        pty.launchIncarnationId === incarnationId &&
        pty.connectionId === (record.connectionId ?? null) &&
        pty.worktreeId === record.worktreeId &&
        this.terminalRunFacts.readProcessStartedAt(ptyId, incarnationId) !== null
      )
    }
    await admitsMailWakeRetry(record, {
      current: () =>
        this.hasSleepingMailForPane(record.paneKey)
          ? this.sleepingMailRecord(record.paneKey)
          : null,
      owns,
      commandEnded: () => this.mailWakeInvocations.ended(record),
      occupied: (ptyId) => this.mailWakeShellOccupied(ptyId),
      drivingInputAt: (ptyId) => this.terminalRunFacts.readLastDrivingInputAt(ptyId),
      inspect: (ptyId, incarnationId) =>
        this.ptyController?.inspectProcess?.(ptyId, {
          expectedIncarnationId: incarnationId,
          scanChildProcesses: true
        }) ?? Promise.resolve(undefined),
      shellInFront: async (ptyId) =>
        (await this.readLaunchedAgentForeground(ptyId, record.agent)) === 'shell'
    })
    // Host-side input fencing is required before a proven failed invocation may be stopped.
    return false
  }

  async readSleepingMailHold(mailbox: string): Promise<MailboxDeliveryHold | null> {
    this.watchSleepingMail()
    const record = this.sleptMailboxWake.batch(mailbox)?.record
    if (!record || !mailWakeObligation(record)) {
      return null
    }
    const attempt = record.mailWake?.attempt
    const pty = this.getPtyRecordForPaneKey(record.paneKey)
    const liveShell =
      !!attempt &&
      pty?.connected === true &&
      pty.ptyId === attempt.ptyId &&
      pty.incarnationId === attempt.incarnationId &&
      pty.launchToken === attempt.launchToken &&
      pty.launchIncarnationId === attempt.incarnationId &&
      pty.worktreeId === record.worktreeId &&
      pty.connectionId === (record.connectionId ?? null) &&
      this.mailWakeInvocations.ended(record) &&
      (await this.readLaunchedAgentForeground(attempt.ptyId, record.agent)) === 'shell' &&
      this.getPtyRecordForPaneKey(record.paneKey) === pty &&
      this.sleepingMailRecord(record.paneKey) === record
    return {
      kind: 'asleep',
      waking:
        mailWakeObligation(record) === 'automatic' && !this.sleptMailboxWake.failedToWake(record),
      resuming: mailWakeObligation(record) === 'retained' && !liveShell,
      agentName: TUI_AGENT_DISPLAY_NAMES[record.agent],
      openTab: record.restoreOnTabOpenOnly === true,
      failed: this.sleptMailboxWake.failedToWake(record),
      liveShell,
      workspaceName: this.resolvedWorktrees
        .peek()
        ?.worktrees.find((row) => row.id === record.worktreeId)?.displayName
    }
  }
}
