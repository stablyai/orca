import * as inboxes from './sleeping-mail-owner-mailboxes'
import { retryOnHostConnect, SleepingMailCrewWatch } from './sleeping-mail-crew-watch'
import { MailWakeAttempts } from './mail-wake-attempts'
import { SleepingMailRecordIndex } from './sleeping-mail-record-index'
import { mailWakeObligation, type SleptMailRecord } from './mail-wake-obligation'
import { queueTerminalWorkspaceCommand } from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import { MailWakeInvocations } from './mail-wake-invocations'
import { RuntimeMailWakeAdmission } from './runtime-mail-wake-admission'
import { SleptMailboxWake } from './slept-mailbox-wake'
import { SleptPaneHost } from './slept-pane-host'

const NO_RECORDS: Readonly<Record<string, SleptMailRecord>> = Object.freeze({})

export abstract class RuntimeSleptMailboxWakes extends RuntimeMailWakeAdmission {
  protected readonly mailWakeInvocations = new MailWakeInvocations()
  protected readonly sleptMailboxWake = new SleptMailboxWake({
    db: () => this._orchestrationDb,
    record: (paneKey) => this.sleepingMailRecord(paneKey),
    handlePane: (mailbox) => this.sleptAgentPaneForHandle(mailbox)?.paneKey ?? null,
    currentPane: (recorded) => this.sleepingRecordIndex.currentPane(recorded),
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
      let claimedId: string | undefined
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
            claimedId = claimed.mailWake?.id
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
        const woke = await confirmed
        const attempt = this.mailWakeAttempts.get(record.paneKey)
        // A window that answered but never launched under this attempt leaves no process to wait for.
        if (
          !woke &&
          attempt &&
          attempt.mailWake?.id === claimedId &&
          !this.mailWakeAttempts.stampLaunch(attempt).mailWake?.attempt
        ) {
          this.settleMailWakeAttempt(attempt)
        }
        return woke
      } finally {
        clearTimeout(timeout)
        stop.abort()
      }
    }
  })

  private watchingSleepingMail = false
  protected readonly sleepingRecordIndex = new SleepingMailRecordIndex()
  /** Persisted sleep records only; a mail wake's temporary custody lives in mailWakeAttempts. */
  protected readonly sleepingRecords = this.sleepingRecordIndex.records
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

  private readonly sleptRecordsOf = (host: string) =>
    this.store?.getWorkspaceSession?.(host)?.sleepingAgentSessionsByPaneKey ?? NO_RECORDS
  private readonly reindexSleptPane = (pane: string) => this.sleptMailboxWake.refreshPane(pane)

  private readonly sleptPaneHost = new SleptPaneHost(this.sleepingRecordIndex, (repoId) =>
    this.store?.getRepo?.(repoId)
  )

  private readonly sleepingMailCrewWatch = new SleepingMailCrewWatch(
    () => this.crewChanges,
    (scope) => this.publishSleepingMail(scope),
    () => this.sleptMailboxWake.trackedMailboxes()
  )

  protected watchSleepingMail(): void {
    if (this.watchingSleepingMail) {
      return
    }
    this.watchingSleepingMail = true
    for (const host of this.store?.getWorkspaceSessionHostIds?.() ?? ['local']) {
      this.sleepingRecordIndex.refresh(host, this.sleptRecordsOf(host), this.reindexSleptPane)
    }
    this.sleepingRecordIndex.finishInitialRead()
    retryOnHostConnect(
      (listener) => this.onClientEvent(listener, { consumesTerminalSideEffects: false }),
      (host) => this.retrySleptMailboxWakes(undefined, host)
    )
    this.subscribeAgentStatusRowChanges((paneKey) => this.watchMailWakeInvocations(paneKey))
    this.sleepingMailCrewWatch.sync(this.owesAnySleepingMail())
    this.store?.onWorkspaceSessionWritten?.((hostId) => {
      const live = () => this.store?.getWorkspaceSessionHostIds?.() ?? ['local']
      const index = this.sleepingRecordIndex
      const written = index.sessionWritten(hostId, live, this.sleptRecordsOf, this.reindexSleptPane)
      for (const changed of written) {
        for (const pane of changed) {
          this.watchMailWakeInvocations(pane)
          this.onSleepingRecordChanged(pane)
        }
        if (changed.size) {
          this.sleepingMailCrewWatch.sync(this.owesAnySleepingMail())
          queueMicrotask(() => this.publishSleepingMail({ panes: changed }))
        }
      }
    })
  }

  /** A pane's saved sleep record changed: owners waiting on that pane re-check it. */
  protected onSleepingRecordChanged(_paneKey: string): void {}

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

  private readonly sleptPaneInboxes = (pane: string) =>
    inboxes.sleepingPaneInboxes(
      this._orchestrationDb,
      pane,
      this.sleepingMailRecord(pane),
      this.sleepingRecordIndex.takeArrival(pane)
    )

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
      this.publishHeldWorktrees()
    }
  }

  /** A window (re)load re-announces the held set and re-checks every sleeper; a host coming back
   *  can only unblock a wake that failed, so it re-checks just the tracked mailboxes (a named
   *  host's own, when the edge names one). */
  retrySleptMailboxWakes(paneKey?: string, hostEdge: boolean | string = false): void {
    this.watchSleepingMail()
    const onHost = typeof hostEdge === 'string' ? this.sleptPaneHost.on(hostEdge) : undefined
    this.sleptMailboxWake.retryFailed(paneKey, onHost)
    if (paneKey === undefined && !hostEdge) {
      this.resetHeldWorktreesPublication()
    }
    this.getExistingOrchestrationDb()
    const tracked = () => ({ mailboxes: this.sleptMailboxWake.trackedMailboxes(onHost), panes: [] })
    const scope = paneKey !== undefined ? { panes: [paneKey] } : hostEdge ? tracked() : undefined
    this.publishSleepingMail(scope, true)
  }

  private sleepingMailPublicationQueued = false
  private readonly sleepingMailScope = {
    full: true,
    urgent: true,
    mailboxes: new Set<string>(),
    panes: new Set<string>()
  }

  private sleepingMailPanes(): Set<string> {
    return new Set([...this.sleepingRecords.keys(), ...this.mailWakeAttempts.panes()])
  }

  protected owesAnySleepingMail(): boolean {
    return (
      this.sleepingRecords.size > 0 ||
      this.mailWakeAttempts.size > 0 ||
      this.sleptMailboxWake.hasTrackedMail
    )
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
      this.lastFullSleepingMailPass = full ? Date.now() : this.lastFullSleepingMailPass
      const [mailboxes, panes] = [[...pending.mailboxes], [...pending.panes]]
      pending.full = false
      pending.mailboxes.clear()
      pending.panes.clear()
      try {
        this.mailWakeAttempts.load()
        if (!this._orchestrationDb || !this.owesAnySleepingMail()) {
          return
        }
        const [wake, direct] = [this.sleptMailboxWake, this.sleptPaneInboxes]
        wake.inPass(() => {
          const affected = full
            ? inboxes.reconcileSleepingMail(wake, this.sleepingMailPanes(), direct, mailboxes)
            : inboxes.refreshSleepingMailScope(wake, mailboxes, panes, direct)
          for (const pane of affected) {
            const attempt = this.mailWakeAttempts.get(pane)
            if (
              attempt &&
              !this.holdsSleptPaneWake(pane) &&
              (!wake.owesPane(pane) || this.mailWakeLost(attempt))
            ) {
              this.settleMailWakeAttempt(attempt)
            }
            for (const mailbox of wake.mailboxesForPane(pane)) {
              wake.request(mailbox)
            }
          }
        })
      } catch {
        /* The runtime can close its database before a queued publication. */
      } finally {
        this.publishHeldWorktrees()
        this.sleepingMailCrewWatch.sync(this.owesAnySleepingMail())
        this.sleepingMailPublicationQueued = false
        if (pending.full || pending.mailboxes.size || pending.panes.size) {
          this.publishSleepingMail({})
        }
      }
    }
    if (wait > 0) {
      setTimeout(run, wait)
    } else {
      // A burst of availability edges (many hosts reconnecting) shares one full pass.
      ;(pending.full ? setImmediate : queueMicrotask)(run)
    }
  }

  private lastFullSleepingMailPass = 0
}
