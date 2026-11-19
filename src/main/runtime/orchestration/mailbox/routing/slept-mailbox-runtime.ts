import { sessionCrewChanges, type CrewInvalidation } from '../../crew/crew-changes'
import { replaceMailWakeRecord } from '../../../session-lifecycle/projection/retained-mail-wake-attempt'
import { SleepingMailRecordIndex } from './sleeping-mail-record-index'
import {
  mailWakeObligation,
  withoutMailWake
} from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import { queueTerminalWorkspaceCommand } from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import { MailWakeInvocations } from './mail-wake-invocations'
import { RuntimeMailWakeAdmission } from './runtime-mail-wake-admission'
import { SleptMailboxWake } from './slept-mailbox-wake'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

export abstract class RuntimeSleptMailboxWakes extends RuntimeMailWakeAdmission {
  protected readonly mailWakeInvocations = new MailWakeInvocations()
  protected readonly sleptMailboxWake = new SleptMailboxWake({
    db: () => this._orchestrationDb,
    record: (paneKey) => this.sleepingMailRecord(paneKey),
    waiters: (mailbox) => this.messageWaiters.get(mailbox),
    prepare: async (record) => {
      if (this.graphStatus !== 'ready') {
        throw new Error('Window is still restoring')
      }
      if (!(await this.notifier?.resumeSleepingAgents?.(record.worktreeId, record.paneKey, true))) {
        throw new Error('Open the workspace to resume the agent')
      }
    },
    // TEMPORARY: window-owned Agent sleep needs a connected client; host-only wake is tracked in STA-15080.
    wake: async (record) => {
      const stop = new AbortController()
      const confirmed = this.mailWakeInvocations.wait(record, stop.signal)
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const accepted = await queueTerminalWorkspaceCommand(this, `id:${record.worktreeId}`, {
          kind: 'wake',
          run: async () => {
            const current = this.sleepingMailRecord(record.paneKey)
            if (
              !current ||
              !this.hasSleepingMailForPane(record.paneKey) ||
              mailWakeObligation(current) === 'manual' ||
              (current.mailWake?.capturedAt ?? current.capturedAt) !==
                (record.mailWake?.capturedAt ?? record.capturedAt)
            ) {
              return false
            }
            // A wake already attempted for this mail is not started again automatically.
            if (current.mailWake) {
              return false
            }
            if (this.getPtyRecordForPaneKey(current.paneKey)?.connected) {
              return false
            }
            return (
              (await this.notifier?.resumeSleepingAgents?.(current.worktreeId, current.paneKey)) ===
              true
            )
          }
        })
        if (!accepted) {
          return false
        }
        this.watchMailWakeInvocations()
        timeout = setTimeout(() => stop.abort(), 30_000)
        return await confirmed
      } finally {
        clearTimeout(timeout)
        stop.abort()
      }
    }
  })

  private watchingSleepingMail = false
  private readonly sleepingRecordIndex = new SleepingMailRecordIndex()
  private readonly sleepingRecords = this.sleepingRecordIndex.records
  private readonly custodyRecords = this.sleepingRecordIndex.custody

  private refreshSleepingRecords(host: string): Set<string> {
    const changed = this.sleepingRecordIndex.refresh(
      host,
      this.store?.getWorkspaceSession?.(host)?.sleepingAgentSessionsByPaneKey ?? {},
      (pane) => this.sleptMailboxWake.refreshPane(pane)
    )
    if (changed.size) {
      this.mailWakeInvocations.retain(this.sleepingRecordIndex.launchTokens())
    }
    return changed
  }

  protected watchSleepingMail(): void {
    if (this.watchingSleepingMail) {
      return
    }
    this.watchingSleepingMail = true
    for (const host of this.store?.getWorkspaceSessionHostIds?.() ?? ['local']) {
      this.refreshSleepingRecords(host)
    }
    this.onClientEvent(
      (event) => {
        if (event.type === 'sshStateChanged' && event.state.status === 'connected') {
          this.retrySleptMailboxWakes()
        }
      },
      { consumesTerminalSideEffects: false }
    )
    this.subscribeAgentStatusRowChanges((paneKey) => this.watchMailWakeInvocations(paneKey))
    const changed = (facets: CrewInvalidation) => {
      if (facets.has('traffic') || facets.has('topology') || facets.has('records')) {
        this.publishSleepingMail()
      }
    }
    this.crewChanges.subscribe(changed)
    sessionCrewChanges.subscribe(changed)
    this.store?.onWorkspaceSessionWritten?.((hostId) => {
      for (const host of this.sleepingRecordIndex.affectedHosts(
        hostId,
        this.store?.getWorkspaceSessionHostIds?.() ?? ['local']
      )) {
        const changed = this.refreshSleepingRecords(host)
        for (const pane of changed) {
          this.watchMailWakeInvocations(pane)
        }
        if (changed.size) {
          queueMicrotask(() => this.publishSleepingMail())
        }
      }
    })
  }

  private watchMailWakeInvocations(paneKey?: string): void {
    const record = paneKey ? this.custodyRecords.get(paneKey) : undefined
    for (const current of paneKey ? (record ? [record] : []) : this.custodyRecords.values()) {
      const attempt = current.mailWake?.attempt
      if (!attempt) {
        continue
      }
      if (
        this.terminalRunFacts.readProcessStartedAt(attempt.ptyId, attempt.incarnationId) !== null
      ) {
        this.mailWakeInvocations.watch(current, this)
      }
      const pty = this.getPtyRecordForPaneKey(current.paneKey)
      if (
        pty?.connected === true &&
        pty.worktreeId === current.worktreeId &&
        pty.connectionId === (current.connectionId ?? null) &&
        pty.incarnationId === attempt.incarnationId &&
        pty.launchToken === attempt.launchToken &&
        pty.launchIncarnationId === attempt.incarnationId &&
        this.mailWakeInvocations.observe(
          current,
          this.getAgentProviderSessionRowsForPaneFn?.(current.paneKey) ?? [],
          pty.ptyId
        )
      ) {
        this.sleptMailboxWake.confirmed(current)
        void this.editMailWakeRecord(current, withoutMailWake(current)).catch((error: unknown) =>
          console.warn('[orchestration] could not settle resumed mail custody', error)
        )
      }
    }
  }

  protected async editMailWakeRecord(
    record: SleepingAgentSessionRecord,
    next: SleepingAgentSessionRecord
  ): Promise<boolean> {
    let changed = false
    await this.commitWorkspaceSessionEdit(
      this.getWorkspaceSessionHostIdForWorktree(record.worktreeId),
      (session) => {
        const edited = replaceMailWakeRecord(session, record, next)
        changed = edited !== null
        return edited
      }
    )
    if (changed && record.mailWake && !next.mailWake) {
      this.settledMailWakeIds.add(record.mailWake.id)
      this.publishSleepingMail()
    }
    return changed
  }

  protected sleepingMailRecord(paneKey: string): SleepingAgentSessionRecord | null {
    return this.sleepingRecords.get(paneKey) ?? null
  }

  protected hasSleepingMailForPane(paneKey: string): boolean {
    return this.sleptMailboxWake.owesPane(paneKey)
  }

  protected requestSleptMailboxWake(mailbox: string, reservedTypes?: ReadonlySet<string>): void {
    this.watchSleepingMail()
    if (this.sleepingRecords.size || this.sleptMailboxWake.hasTrackedMail) {
      this.sleptMailboxWake.request(mailbox, reservedTypes)
    }
  }

  retrySleptMailboxWakes(paneKey?: string): void {
    this.watchSleepingMail()
    if (paneKey === undefined) {
      this.sleepingMailPublication = ''
    }
    this.getExistingOrchestrationDb()
    this.publishSleepingMail()
  }

  private readonly settledMailWakeIds = new Set<string>()
  private sleepingMailPublicationDirty = false
  private sleepingMailPublicationQueued = false
  private sleepingMailPublication = ''

  /** Any crew change re-derives what the few sleeping panes are owed; publications coalesce. */
  protected publishSleepingMail(): void {
    if (this.sleepingMailPublicationQueued) {
      this.sleepingMailPublicationDirty = true
      return
    }
    this.sleepingMailPublicationQueued = true
    queueMicrotask(async () => {
      try {
        if (!this._orchestrationDb) {
          return
        }
        if (this.sleepingRecords.size || this.sleptMailboxWake.hasTrackedMail) {
          this.sleptMailboxWake.reconcile(this.sleepingRecords.keys())
        }
        for (const [pane, record] of Array.from(this.custodyRecords)) {
          if (!this.sleptMailboxWake.owesPane(pane)) {
            await this.editMailWakeRecord(record, withoutMailWake(record))
          }
        }
        for (const pane of this.sleepingRecords.keys()) {
          for (const mailbox of this.sleptMailboxWake.mailboxesForPane(pane)) {
            this.sleptMailboxWake.request(mailbox)
          }
        }
        const settledIds = [...this.settledMailWakeIds]
        this.settledMailWakeIds.clear()
        const ids = this.sleptMailboxWake.heldWorktrees()
        const key = JSON.stringify(ids)
        if (key !== this.sleepingMailPublication || settledIds.length) {
          this.sleepingMailPublication = key
          this.notifier?.sleepingMailChanged?.(ids, ...(settledIds.length ? [settledIds] : []))
        }
      } catch {
        /* The runtime can close its database before a queued publication. */
      } finally {
        this.sleepingMailPublicationQueued = false
        if (this.sleepingMailPublicationDirty) {
          this.sleepingMailPublicationDirty = false
          this.publishSleepingMail()
        }
      }
    })
  }
}
