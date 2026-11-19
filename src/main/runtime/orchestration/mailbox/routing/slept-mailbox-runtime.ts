import { sessionCrewChanges, type CrewInvalidation } from '../../crew/crew-changes'
import { MailWakeAttempts } from './mail-wake-attempts'
import { SleepingMailRecordIndex } from './sleeping-mail-record-index'
import { mailWakeObligation, type SleptMailRecord } from './mail-wake-obligation'
import { queueTerminalWorkspaceCommand } from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import { MailWakeInvocations } from './mail-wake-invocations'
import { RuntimeMailWakeAdmission } from './runtime-mail-wake-admission'
import { SleptMailboxWake } from './slept-mailbox-wake'

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
    // TODO(STA-15080): the window resumes the pane until main owns pane layout (phase F); then main
    // ensures the agent runs and delivers, as host-owned wakes do. Desktop-owned resume has precedent.
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
              current.capturedAt !== record.capturedAt
            ) {
              return false
            }
            // A wake already attempted for this mail is not started again automatically.
            if (current.mailWake || this.getPtyRecordForPaneKey(current.paneKey)?.connected) {
              return false
            }
            const claimed = this.mailWakeAttempts.claim(current)
            if (!claimed) {
              return false
            }
            const resumed =
              (await Promise.resolve(
                this.notifier?.resumeSleepingAgents?.(current.worktreeId, current.paneKey)
              ).catch(() => false)) === true
            if (!resumed) {
              // Nothing was launched, so a later edge may wake this pane again.
              this.settleMailWakeAttempt(claimed)
            }
            return resumed
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
  private readonly mailWakeAttempts = new MailWakeAttempts({
    db: () => this._orchestrationDb,
    pty: (paneKey) => this.getPtyRecordForPaneKey(paneKey)
  })

  protected settleMailWakeAttempt(record: SleptMailRecord): void {
    if (this.mailWakeAttempts.settle(record)) {
      this.mailWakeInvocations.retain(this.mailWakeAttempts.launchTokens())
      this.publishSleepingMail()
    }
  }

  private refreshSleepingRecords(host: string): Set<string> {
    return this.sleepingRecordIndex.refresh(
      host,
      this.store?.getWorkspaceSession?.(host)?.sleepingAgentSessionsByPaneKey ?? {},
      (pane) => this.sleptMailboxWake.refreshPane(pane)
    )
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
    const record = paneKey ? this.mailWakeAttempts.get(paneKey) : undefined
    for (const claimed of paneKey ? (record ? [record] : []) : this.mailWakeAttempts.records()) {
      const current = this.mailWakeAttempts.stampLaunch(claimed)
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
        this.settleMailWakeAttempt(current)
      }
    }
  }

  protected sleepingMailRecord(paneKey: string): SleptMailRecord | null {
    return this.mailWakeAttempts.get(paneKey) ?? this.sleepingRecords.get(paneKey) ?? null
  }

  protected hasSleepingMailForPane(paneKey: string): boolean {
    return this.sleptMailboxWake.owesPane(paneKey)
  }

  protected requestSleptMailboxWake(mailbox: string, reservedTypes?: ReadonlySet<string>): void {
    this.watchSleepingMail()
    if (this.owesAnySleepingMail()) {
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

  private sleepingMailPublicationDirty = false
  private sleepingMailPublicationQueued = false
  private sleepingMailPublication = ''

  private owesAnySleepingMail(): boolean {
    return (
      this.sleepingRecords.size > 0 ||
      this.mailWakeAttempts.size > 0 ||
      this.sleptMailboxWake.hasTrackedMail
    )
  }

  private sleepingMailPanes(): Set<string> {
    return new Set([...this.sleepingRecords.keys(), ...this.mailWakeAttempts.panes()])
  }

  /** Any crew change re-derives what the few sleeping panes are owed; publications coalesce. */
  protected publishSleepingMail(): void {
    if (this.sleepingMailPublicationQueued) {
      this.sleepingMailPublicationDirty = true
      return
    }
    this.sleepingMailPublicationQueued = true
    queueMicrotask(() => {
      try {
        if (!this._orchestrationDb) {
          return
        }
        this.mailWakeAttempts.load()
        this.mailWakeInvocations.retain(this.mailWakeAttempts.launchTokens())
        if (this.owesAnySleepingMail()) {
          this.sleptMailboxWake.reconcile(this.sleepingMailPanes())
        }
        for (const record of this.mailWakeAttempts.records()) {
          if (!this.sleptMailboxWake.owesPane(record.paneKey)) {
            this.settleMailWakeAttempt(record)
          }
        }
        for (const pane of this.sleepingMailPanes()) {
          for (const mailbox of this.sleptMailboxWake.mailboxesForPane(pane)) {
            this.sleptMailboxWake.request(mailbox)
          }
        }
        const ids = this.sleptMailboxWake.heldWorktrees()
        const key = JSON.stringify(ids)
        if (key !== this.sleepingMailPublication) {
          this.sleepingMailPublication = key
          this.notifier?.sleepingMailChanged?.(ids)
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
