import type { SleptMailboxWake } from './slept-mailbox-wake'
import { mailWakeObligation, type SleptMailRecord } from './mail-wake-obligation'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import type { MailboxDeliveryHold } from '../delivery-hold/mailbox-delivery-hold'
import { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from '../../../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { RuntimePtyWorktreeRecord } from '../../../terminal/records/runtime-terminal-state-records'
import type { MailWakeInvocations } from './mail-wake-invocations'
import type { MailWakeAttempts } from './mail-wake-attempts'

export abstract class RuntimeMailWakeAdmission extends OrcaRuntimeWithPruneMobileSessionTabGroupLayout {
  protected abstract readonly mailWakeInvocations: MailWakeInvocations
  protected abstract readonly mailWakeAttempts: MailWakeAttempts
  protected abstract settleMailWakeAttempt(record: SleptMailRecord): void
  protected abstract hasSleepingMailForPane(paneKey: string): boolean
  protected abstract sleepingMailRecord(paneKey: string): SleptMailRecord | null
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
    const failed = this.sleptMailboxWake.failedToWake(record)
    const waking = mailWakeObligation(record) === 'automatic' && !failed
    const resuming = current && !ended && foreground === 'agent'
    return {
      kind: 'asleep',
      waking,
      resuming,
      agentName: TUI_AGENT_DISPLAY_NAMES[record.agent],
      openTab: record.restoreOnTabOpenOnly === true,
      failed,
      liveShell,
      // Only the open-it-yourself wording names the workspace.
      workspaceName:
        waking || resuming || liveShell
          ? undefined
          : this.resolvedWorktrees.peek()?.worktrees.find((row) => row.id === record.worktreeId)
              ?.displayName
    }
  }

  protected confirmMailWake(record: SleptMailRecord): void {
    this.mailWakeInvocations.confirm(record)
    this.sleptMailboxWake.confirmed(record)
    this.settleMailWakeAttempt(record)
  }

  /** The process a wake launched is gone; its mail stays queued for the agent's next run. */
  protected mailWakeLost(record: SleptMailRecord): boolean {
    const launch = record.mailWake?.attempt
    const pty = this.getPtyRecordForPaneKey(record.paneKey)
    return (
      !!launch &&
      (this.mailWakeInvocations.ended(record) ||
        (!!pty && (pty.connected !== true || pty.incarnationId !== launch.incarnationId)))
    )
  }

  /** Agents that report no hook until their first turn confirm by their launched process instead. */
  protected async probeMailWakeForeground(paneKey: string, signal: AbortSignal): Promise<void> {
    for (const delay of [1_000, 2_000, 4_000, 8_000, 12_000]) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      const record = this.mailWakeAttempts.get(paneKey)
      const launched = record && this.mailWakeAttempts.stampLaunch(record)
      const launch = launched?.mailWake?.attempt
      const pty = this.getPtyRecordForPaneKey(paneKey)
      if (signal.aborted || !launched) {
        return
      }
      if (
        launch &&
        pty?.connected === true &&
        pty.ptyId === launch.ptyId &&
        pty.incarnationId === launch.incarnationId &&
        (await this.readLaunchedAgentForeground(launch.ptyId, launched.agent)) === 'agent' &&
        !signal.aborted &&
        this.mailWakeAttempts.get(paneKey) === launched
      ) {
        this.confirmMailWake(launched)
        return
      }
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
