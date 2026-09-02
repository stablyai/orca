import type { OrchestrationDb } from './db'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'

type OrchestrationMailboxDeliveryTargetDependencies = {
  getDb: () => OrchestrationDb | null
  getTerminalHandleForPaneKey: (paneKey: string) => string | null
  hasTerminalHandle: (handle: string) => boolean
  canProbePtyLiveness: () => boolean
  controllerKnowsPtyIsLive: (ptyId: string) => boolean
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
}

export class OrchestrationMailboxDeliveryTarget {
  private readonly probeDeferredPtyIds = new Set<string>()

  constructor(private readonly deps: OrchestrationMailboxDeliveryTargetDependencies) {}

  resolveTerminalHandle(handle: string): string | null {
    if (this.deps.hasTerminalHandle(handle)) {
      return handle
    }
    const db = this.deps.getDb()
    const runId = handle.startsWith('run:') ? handle.slice('run:'.length) : ''
    const dispatchId = handle.startsWith('dispatch:') ? handle.slice('dispatch:'.length) : ''
    const dispatch = dispatchId ? db?.getDispatchContextById?.(dispatchId) : undefined
    const remote =
      dispatchId && !dispatch ? db?.getRemoteDispatchAttachment?.(dispatchId) : undefined
    const paneKey = dispatch?.assignee_pane_key ?? remote?.pane_key
    const ownerHandle = runId
      ? db?.getRun(runId)?.coordinator_handle
      : ((paneKey ? this.deps.getTerminalHandleForPaneKey(paneKey) : null) ??
        dispatch?.assignee_handle ??
        remote?.terminal_handle)
    return ownerHandle && this.deps.hasTerminalHandle(ownerHandle) ? ownerHandle : null
  }

  deferForAbsenceProbe(
    leaf: OrchestrationMailboxLeaf,
    mailboxHandle: string,
    skipAbsenceProbe: boolean | undefined,
    redeliver: (leaf: OrchestrationMailboxLeaf, ptyId: string, mailboxHandle: string) => void
  ): boolean {
    const ptyId = leaf.ptyId
    if (
      !ptyId ||
      skipAbsenceProbe ||
      !this.deps.canProbePtyLiveness() ||
      this.deps.controllerKnowsPtyIsLive(ptyId)
    ) {
      return false
    }
    if (this.probeDeferredPtyIds.has(ptyId)) {
      return true
    }
    this.probeDeferredPtyIds.add(ptyId)
    void this.deps
      .isLeafPtyProvenAbsent(ptyId)
      .then((absent) => {
        this.probeDeferredPtyIds.delete(ptyId)
        if (!absent && leaf.ptyId === ptyId) {
          setTimeout(() => redeliver(leaf, ptyId, mailboxHandle), 0)
        }
      })
      .catch(() => this.probeDeferredPtyIds.delete(ptyId))
    return true
  }
}
