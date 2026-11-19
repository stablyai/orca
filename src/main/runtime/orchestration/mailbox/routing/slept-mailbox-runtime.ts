import { reconcileSleepingMail, refreshSleepingMailScope } from './sleeping-mail-owner-mailboxes'
import { sessionCrewChanges, type CrewInvalidation } from '../../crew/crew-changes'
import { MailWakeAttempts } from './mail-wake-attempts'
import { SleepingMailRecordIndex } from './sleeping-mail-record-index'
import { mailWakeObligation, type SleptMailRecord } from './mail-wake-obligation'
import { queueTerminalWorkspaceCommand } from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import { MailWakeInvocations } from './mail-wake-invocations'
import { RuntimeMailWakeAdmission } from './runtime-mail-wake-admission'
import { SleptMailboxWake } from './slept-mailbox-wake'

const NO_RECORDS: Readonly<Record<string, SleptMailRecord>> = Object.freeze({})

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
                this.notifier?.resumeSleepingAgents?.(
                  current.worktreeId,
                  current.paneKey,
                  false,
                  claimed.mailWake?.id
                )
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
        this.watchMailWakeInvocations(record.paneKey)
        timeout = setTimeout(() => stop.abort(), 30_000)
        void this.probeMailWakeForeground(record.paneKey, stop.signal)
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
  protected readonly mailWakeAttempts = new MailWakeAttempts({
    db: () => this._orchestrationDb,
    pty: (paneKey) => this.getPtyRecordForPaneKey(paneKey)
  })

  protected settleMailWakeAttempt(record: SleptMailRecord): void {
    if (this.mailWakeAttempts.settle(record)) {
      this.mailWakeInvocations.release(record.mailWake?.id)
      this.publishSleepingMail({ panes: [record.paneKey] })
    }
  }

  private refreshSleepingRecords(host: string): Set<string> {
    return this.sleepingRecordIndex.refresh(
      host,
      this.store?.getWorkspaceSession?.(host)?.sleepingAgentSessionsByPaneKey ?? NO_RECORDS,
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
    // A change that names its mailboxes refreshes only those; an unnamed one re-derives every sleeper.
    const changed = (facets: CrewInvalidation) => {
      if (facets.has('traffic') || facets.has('topology') || facets.has('records')) {
        this.publishSleepingMail(
          facets.trafficAddresses ? { mailboxes: facets.trafficAddresses } : undefined
        )
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
          queueMicrotask(() => this.publishSleepingMail({ panes: changed }))
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
        this.confirmMailWake(current)
      } else if (this.mailWakeLost(current)) {
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
    this.sleptMailboxWake.retryFailed()
    if (paneKey === undefined) {
      this.resetHeldWorktreesPublication()
    }
    this.getExistingOrchestrationDb()
    this.publishSleepingMail(paneKey === undefined ? undefined : { panes: [paneKey] }, true)
  }

  private sleepingMailPublicationQueued = false
  private readonly sleepingMailScope = {
    full: true,
    urgent: true,
    mailboxes: new Set<string>(),
    panes: new Set<string>()
  }

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

  /** Coalesces what changed into one pass: named mailboxes and panes, or every sleeping pane. */
  protected publishSleepingMail(
    scope?: { mailboxes?: Iterable<string>; panes?: Iterable<string> },
    urgent = false
  ): void {
    const pending = this.sleepingMailScope
    if (!scope) {
      pending.full = true
    }
    pending.urgent ||= urgent
    for (const mailbox of scope?.mailboxes ?? []) {
      pending.mailboxes.add(mailbox)
    }
    for (const pane of scope?.panes ?? []) {
      pending.panes.add(pane)
    }
    if (this.sleepingMailPublicationQueued) {
      return
    }
    this.sleepingMailPublicationQueued = true
    // A full pass re-queries every sleeper, so unnamed changes share one pass per second.
    const wait =
      pending.full && !pending.urgent ? this.lastFullSleepingMailPass + 1_000 - Date.now() : 0
    const run = () => {
      const full = pending.full
      pending.urgent = false
      if (full) {
        this.lastFullSleepingMailPass = Date.now()
      }
      const mailboxes = [...pending.mailboxes]
      const panes = [...pending.panes]
      pending.full = false
      pending.mailboxes.clear()
      pending.panes.clear()
      try {
        const db = this._orchestrationDb
        if (!db) {
          return
        }
        this.mailWakeAttempts.load()
        if (!this.owesAnySleepingMail()) {
          return
        }
        let affected: Iterable<string>
        if (full) {
          affected = this.sleepingMailPanes()
          reconcileSleepingMail(this.sleptMailboxWake, db, affected)
        } else {
          affected = refreshSleepingMailScope(this.sleptMailboxWake, db, mailboxes, panes)
        }
        for (const pane of affected) {
          const attempt = this.mailWakeAttempts.get(pane)
          if (attempt && (!this.sleptMailboxWake.owesPane(pane) || this.mailWakeLost(attempt))) {
            this.settleMailWakeAttempt(attempt)
          }
          for (const mailbox of this.sleptMailboxWake.mailboxesForPane(pane)) {
            this.sleptMailboxWake.request(mailbox)
          }
        }
      } catch {
        /* The runtime can close its database before a queued publication. */
      } finally {
        this.publishHeldWorktrees()
        this.sleepingMailPublicationQueued = false
        if (pending.full || pending.mailboxes.size || pending.panes.size) {
          this.publishSleepingMail({})
        }
      }
    }
    if (wait > 0) {
      setTimeout(run, wait)
    } else {
      queueMicrotask(run)
    }
  }

  private lastFullSleepingMailPass = 0
}
