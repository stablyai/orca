import {
  mailWakeObligation,
  mailWakeEligibility,
  withoutMailWake
} from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import { queueTerminalWorkspaceCommand } from '../../../workspaces/lifecycle/workspace-lifecycle-commands'
import { MailWakeInvocations } from './mail-wake-invocations'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { RuntimeMailWakeAdmission } from './runtime-mail-wake-admission'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { SleptMailboxWake } from './slept-mailbox-wake'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { MailboxDeliveryHold } from '../delivery-hold/mailbox-delivery-hold'

export abstract class RuntimeSleptMailboxWakes extends RuntimeMailWakeAdmission {
  protected readonly mailWakeInvocations = new MailWakeInvocations()
  private readonly sleptMailboxWake = new SleptMailboxWake({
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
            if (current.mailWake) {
              const pane = parsePaneKey(current.paneKey)
              const attempt = current.mailWake.attempt
              return (
                !!pane &&
                !!attempt &&
                !!(await this.ensureRestoredPaneStarted(
                  { ...pane, worktreeId: current.worktreeId },
                  {
                    automatic: true,
                    retryMailWake: {
                      id: current.mailWake.id,
                      ptyId: attempt.ptyId,
                      incarnationId: attempt.incarnationId
                    }
                  }
                ))
              )
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

  private watchSleepingMail(): void {
    if (this.watchingSleepingMail) {
      return
    }
    this.watchingSleepingMail = true
    const records = new Map<string, string>()
    for (const host of this.store?.getWorkspaceSessionHostIds?.() ?? ['local']) {
      records.set(host, this.sleepingMailEligibility(host))
    }
    this.onClientEvent(
      (event) => {
        if (event.type === 'sshStateChanged' && event.state.status === 'connected') {
          this.retrySleptMailboxWakes()
        }
      },
      { consumesTerminalSideEffects: false }
    )
    this.subscribeAgentStatusRowChanges(() => this.watchMailWakeInvocations())
    this.crewChanges.subscribe((facets) => {
      if (facets.has('traffic') || facets.has('topology') || facets.has('records')) {
        this.publishSleepingMail()
      }
    })
    this.store?.onWorkspaceSessionWritten?.((hostId) => {
      const hosts =
        hostId === null ? (this.store?.getWorkspaceSessionHostIds?.() ?? ['local']) : [hostId]
      for (const host of hosts) {
        const next = this.sleepingMailEligibility(host)
        this.watchMailWakeInvocations()
        if (records.get(host) !== next) {
          records.set(host, next)
          queueMicrotask(() => this.retrySleptMailboxWakes())
        }
      }
    })
  }

  private sleepingMailEligibility(host: string): string {
    return mailWakeEligibility(
      Object.values(this.store?.getWorkspaceSession?.(host)?.sleepingAgentSessionsByPaneKey ?? {})
    )
  }

  private allMailWakeRecords(): SleepingAgentSessionRecord[] {
    return (this.store?.getWorkspaceSessionHostIds?.() ?? ['local']).flatMap((host) =>
      Object.values(this.store?.getWorkspaceSession?.(host)?.sleepingAgentSessionsByPaneKey ?? {})
    )
  }

  private watchMailWakeInvocations(): void {
    const records = this.allMailWakeRecords()
    const tokens = new Set<string>()
    for (const record of records) {
      const attempt = record.mailWake?.attempt
      if (!attempt) {
        continue
      }
      tokens.add(attempt.launchToken)
      if (
        this.terminalRunFacts.readProcessStartedAt(attempt.ptyId, attempt.incarnationId) !== null
      ) {
        this.mailWakeInvocations.watch(record, this)
      }
      const pty = this.getPtyRecordForPaneKey(record.paneKey)
      if (
        pty?.connected === true &&
        pty.worktreeId === record.worktreeId &&
        pty.connectionId === (record.connectionId ?? null) &&
        pty.incarnationId === attempt.incarnationId &&
        pty.launchToken === attempt.launchToken &&
        pty.launchIncarnationId === attempt.incarnationId &&
        this.mailWakeInvocations.observe(
          record,
          this.getAgentProviderSessionRowsForPaneFn?.(record.paneKey) ?? [],
          pty.ptyId
        )
      ) {
        void this.editMailWakeRecord(record, withoutMailWake(record)).catch((error: unknown) =>
          console.warn('[orchestration] could not settle resumed mail custody', error)
        )
      }
    }
    this.mailWakeInvocations.retain(tokens)
  }

  protected async editMailWakeRecord(
    record: SleepingAgentSessionRecord,
    next: SleepingAgentSessionRecord
  ): Promise<boolean> {
    let changed = false
    await this.commitWorkspaceSessionEdit(
      this.getWorkspaceSessionHostIdForWorktree(record.worktreeId),
      (session) => {
        const current = session.sleepingAgentSessionsByPaneKey?.[record.paneKey]
        if (
          current?.mailWake?.id !== record.mailWake?.id ||
          current?.capturedAt !== record.capturedAt ||
          current?.origin !== record.origin ||
          current?.restoreOnTabOpenOnly !== record.restoreOnTabOpenOnly ||
          current?.mailWake?.attempt?.launchToken !== record.mailWake?.attempt?.launchToken
        ) {
          return null
        }
        changed = true
        return {
          ...session,
          sleepingAgentSessionsByPaneKey: {
            ...session.sleepingAgentSessionsByPaneKey,
            [record.paneKey]: next
          }
        }
      }
    )
    if (changed && record.mailWake && !next.mailWake) {
      this.settledMailWakeIds.add(record.mailWake.id)
      this.publishSleepingMail()
    }
    return changed
  }

  protected sleepingMailRecord(paneKey: string): SleepingAgentSessionRecord | null {
    for (const host of this.store?.getWorkspaceSessionHostIds?.() ?? (['local'] as const)) {
      const record =
        this.store?.getWorkspaceSession?.(host)?.sleepingAgentSessionsByPaneKey?.[paneKey]
      if (record) {
        return record
      }
    }
    return null
  }

  protected hasSleepingMailForPane(paneKey: string): boolean {
    return this.sleptMailboxWake.owesPane(paneKey)
  }

  protected requestSleptMailboxWake(mailbox: string, reservedTypes?: ReadonlySet<string>): void {
    this.sleptMailboxWake.request(mailbox, reservedTypes)
  }

  retrySleptMailboxWakes(): void {
    this.watchSleepingMail()
    this.sleepingMailPublication = ''
    this.publishSleepingMail()
    this.getExistingOrchestrationDb()
    this.scheduleRestoredMessageRepoints()
  }

  private readonly settledMailWakeIds = new Set<string>()
  private sleepingMailPublicationDirty = false
  private sleepingMailPublicationQueued = false
  private sleepingMailPublication = ''

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
        const panes = new Map<string, string>()
        for (const mailbox of this._orchestrationDb?.getUndeliveredUnreadMailboxHandles() ?? []) {
          const batch = this.sleptMailboxWake.batch(mailbox)
          if (batch) {
            panes.set(batch.record.paneKey, batch.record.worktreeId)
          }
        }
        for (const record of this.allMailWakeRecords()) {
          if (record.mailWake && !panes.has(record.paneKey)) {
            await this.editMailWakeRecord(record, withoutMailWake(record))
          }
        }
        const settledIds = [...this.settledMailWakeIds]
        this.settledMailWakeIds.clear()
        const ids = [...new Set(panes.values())].sort()
        const key = JSON.stringify([
          ids,
          this.allMailWakeRecords()
            .filter((record) => record.mailWake)
            .map((record) => record.mailWake!.id)
            .sort()
        ])
        if (key !== this.sleepingMailPublication || settledIds.length) {
          this.sleepingMailPublication = key
          if (settledIds.length) {
            this.notifier?.sleepingMailChanged?.(ids, settledIds)
          } else {
            this.notifier?.sleepingMailChanged?.(ids)
          }
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

  readSleepingMailHold(mailbox: string): MailboxDeliveryHold | null {
    const record = this.sleptMailboxWake.batch(mailbox)?.record
    if (!record || !mailWakeObligation(record)) {
      return null
    }
    return {
      kind: 'asleep',
      agentName: TUI_AGENT_DISPLAY_NAMES[record.agent],
      openTab: record.restoreOnTabOpenOnly === true,
      failed: this.sleptMailboxWake.failedToWake(record),
      liveShell: mailWakeObligation(record) === 'retained',
      workspaceName: this.resolvedWorktrees
        .peek()
        ?.worktrees.find((row) => row.id === record.worktreeId)?.displayName
    }
  }
}
