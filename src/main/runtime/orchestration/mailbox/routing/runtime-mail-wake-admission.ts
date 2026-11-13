import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { mailWakeObligation } from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
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
  protected abstract editMailWakeRecord(
    record: SleepingAgentSessionRecord,
    next: SleepingAgentSessionRecord
  ): Promise<boolean>
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
    const safe = await admitsMailWakeRetry(record, {
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
    if (!safe || !owns(attempt.ptyId, attempt.incarnationId) || !this.ptyController?.stopAndWait) {
      return false
    }
    if (!(await this.ptyController.stopAndWait(attempt.ptyId, { keepHistory: true }))) {
      return false
    }
    const current = this.sleepingMailRecord(record.paneKey)
    if (
      current?.mailWake?.attempt?.launchToken !== attempt.launchToken ||
      mailWakeObligation(current) !== 'retained' ||
      !this.hasSleepingMailForPane(record.paneKey) ||
      (this.terminalRunFacts.readLastDrivingInputAt(attempt.ptyId) ?? -1) >= attempt.startedAt
    ) {
      return false
    }
    return this.editMailWakeRecord(current, {
      ...current,
      mailWake: {
        id: current.mailWake!.id,
        capturedAt: current.mailWake!.capturedAt,
        startedAt: Date.now()
      }
    })
  }
}
