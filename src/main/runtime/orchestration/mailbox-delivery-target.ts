import type { OrchestrationDb } from './db'
import type { OrchestrationMailboxTerminal } from './mailbox-owner'

type OrchestrationMailboxDeliveryTargetDependencies = {
  getDb: () => OrchestrationDb | null
  /** The terminal now in the pane, keyed by its PTY, so a replaced or unlisted PTY is still reached. */
  getMailboxTerminalForPaneKey: (paneKey: string) => OrchestrationMailboxTerminal | null
  getTerminalForHandle: (handle: string) => OrchestrationMailboxTerminal | null
  hasTerminalHandle: (handle: string) => boolean
  /** A structured worker or a chat has no PTY handle; its own lane delivers, so this must not claim it. */
  isStructuredSessionOwner: (handle: string) => boolean
  canProbePtyLiveness: () => boolean
  controllerKnowsPtyIsLive: (ptyId: string) => boolean
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
}

export class OrchestrationMailboxDeliveryTarget {
  private readonly probeDeferredMailboxes = new Map<string, Set<string>>()

  constructor(private readonly deps: OrchestrationMailboxDeliveryTargetDependencies) {}

  resolveTerminal(handle: string): OrchestrationMailboxTerminal | null {
    if (this.deps.hasTerminalHandle(handle)) {
      return this.deps.getTerminalForHandle(handle)
    }
    if (this.deps.isStructuredSessionOwner(handle)) {
      return null
    }
    const db = this.deps.getDb()
    const runId = handle.startsWith('run:') ? handle.slice('run:'.length) : ''
    const dispatchId = handle.startsWith('dispatch:') ? handle.slice('dispatch:'.length) : ''
    const dispatch = dispatchId ? db?.getDispatchContextById?.(dispatchId) : undefined
    const remote =
      dispatchId && !dispatch ? db?.getRemoteDispatchAttachment?.(dispatchId) : undefined
    const run = runId ? db?.getRun(runId) : undefined
    // Runs bind their coordinator by pane; the stored handle is stale once that pane's PTY is replaced.
    const paneKey = run
      ? run.coordinator_pane_key
      : (dispatch?.assignee_pane_key ?? remote?.pane_key)
    const paneTerminal = paneKey ? this.deps.getMailboxTerminalForPaneKey(paneKey) : null
    if (paneTerminal) {
      return paneTerminal
    }
    const ownerHandle = run
      ? run.coordinator_handle
      : (dispatch?.assignee_handle ?? remote?.terminal_handle)
    if (!ownerHandle) {
      return null
    }
    if (this.deps.isStructuredSessionOwner(ownerHandle)) {
      return null
    }
    if (!this.deps.hasTerminalHandle(ownerHandle)) {
      // Log unresolved owners: silent null looks identical to no mail and hides lost routing.
      console.warn('[orchestration] mailbox owner resolved to an unknown terminal', {
        mailboxHandle: handle,
        ownerHandle
      })
      return null
    }
    return this.deps.getTerminalForHandle(ownerHandle)
  }

  deferForAbsenceProbe(
    ptyId: string,
    mailboxHandle: string,
    skipAbsenceProbe: boolean | undefined,
    redeliver: (mailboxHandle: string) => void
  ): boolean {
    if (
      skipAbsenceProbe ||
      !this.deps.canProbePtyLiveness() ||
      this.deps.controllerKnowsPtyIsLive(ptyId)
    ) {
      return false
    }
    // A coordinator of several Runs can defer one mailbox per Run on the same probe.
    const deferred = this.probeDeferredMailboxes.get(ptyId)
    if (deferred) {
      deferred.add(mailboxHandle)
      return true
    }
    const mailboxes = new Set([mailboxHandle])
    this.probeDeferredMailboxes.set(ptyId, mailboxes)
    void this.deps
      .isLeafPtyProvenAbsent(ptyId)
      .then((absent) => {
        this.probeDeferredMailboxes.delete(ptyId)
        if (!absent) {
          for (const deferredMailbox of mailboxes) {
            setTimeout(() => redeliver(deferredMailbox), 0)
          }
        }
      })
      .catch(() => this.probeDeferredMailboxes.delete(ptyId))
    return true
  }
}
