import { makePaneKey, parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { RuntimeLeafRecord } from '../../../terminal/records/runtime-terminal-state-records'
import { LeafIdIndex } from './leaf-id-index'
import { mailWakeObligation } from './mail-wake-obligation'
import { RuntimeSleptMailboxWakes } from './slept-mailbox-runtime'
import { unmountedSleptLeaf } from './unmounted-slept-leaf'

/** A slept agent answers by its handle whether or not the window has mounted its tab: an unmounted
 *  pane is found through the handle its saved sleep record names. */
export abstract class RuntimeUnmountedSleptAgents extends RuntimeSleptMailboxWakes {
  protected readonly leavesByLeafId = new LeafIdIndex()

  /** The pane an Agent-slept handle names: still on its stopped process, and not under the user's own Sleep. */
  protected sleptAgentPaneForHandle(
    handle: string
  ): { paneKey: string; worktreeId: string } | null {
    const slept = this.sleptAgentHandle(handle)
    return slept
      ? {
          paneKey: makePaneKey(slept.leaf.tabId, slept.leaf.leafId),
          worktreeId: slept.leaf.worktreeId
        }
      : null
  }

  /** A slept agent whose tab the window hasn't mounted: after a reload, or while another workspace shows. */
  private unmountedSleptPane(handle: string) {
    // A live terminal's handle (a resumed agent's included) is answered before any sleep record loads.
    if (this.graphStatus !== 'ready' || this.wokenHandlePtyId(handle)) {
      return null
    }
    this.watchSleepingMail()
    const paneKey = this.sleepingRecordIndex.paneForHandle(handle)
    const record = paneKey ? this.sleepingRecords.get(paneKey) : undefined
    const pane = paneKey ? parsePaneKey(paneKey) : null
    // A mounted pane, a moved one included, answers through its own leaf.
    return paneKey &&
      record?.terminalHandle === handle &&
      pane &&
      mailWakeObligation(record) !== 'manual' &&
      !this.leavesByLeafId.find(this.leaves, pane.leafId)
      ? { paneKey, record, pane }
      : null
  }

  protected override unmountedSleptAgentLeaf(handle: string): RuntimeLeafRecord | null {
    const slept = this.unmountedSleptPane(handle)
    // A process running in the pane is the agent awake, though its tab may not be mounted yet.
    if (!slept || this.getPtyRecordForPaneKey(slept.paneKey)?.connected) {
      return null
    }
    return unmountedSleptLeaf(slept.record, slept.pane)
  }

  /** Every slept agent whose tab isn't mounted, for the terminal list; a scoped list reads its workspace's. */
  protected *unmountedSleptAgents(worktreeId?: string): Iterable<RuntimeLeafRecord> {
    this.watchSleepingMail()
    const records = worktreeId
      ? [...this.sleepingRecordIndex.panesIn(worktreeId)].flatMap(
          (pane) => this.sleepingRecords.get(pane) ?? []
        )
      : this.sleepingRecords.values()
    for (const record of records) {
      const leaf = record.terminalHandle
        ? this.unmountedSleptAgentLeaf(record.terminalHandle)
        : null
      if (leaf) {
        yield leaf
      }
    }
  }

  /** A resume spawned into an unmounted slept pane exports the name its record saved. */
  override sleptPaneHandleForSpawn(paneKey: string | null | undefined): string | null {
    return super.sleptPaneHandleForSpawn(paneKey) ?? this.sleptAgentHandleForPane(paneKey)
  }

  /** A resume under a slept agent's saved name takes it over from the stopped process: its aliases go.
   *  A pane-bound name moves on with its leaf instead (retainLeafHandle). */
  override registerPreAllocatedHandleForPty(ptyId: string, handle: string): void {
    const record = this.handles.get(handle)
    const stopped = record?.ptyId ?? this.terminalIdentity.firstReversePtyId(handle)
    if (
      stopped &&
      stopped !== ptyId &&
      this.ptysById.get(stopped)?.connected !== true &&
      !(record && this.leaves.has(this.getLeafKey(record.tabId, record.leafId))) &&
      this.sleepingRecordIndex.paneForHandle(handle) !== null
    ) {
      this.continueHandleLineCursors(handle, ptyId)
      if (this.handleByPtyId.get(stopped) === handle) {
        this.terminalIdentity.unbindPty(stopped)
      }
      if (this.handleByPtyIncarnation.get(stopped)?.handle === handle) {
        this.terminalIdentity.removeIncarnation(stopped)
      }
      if (record) {
        this.terminalIdentity.removeHandle(handle)
      }
    }
    super.registerPreAllocatedHandleForPty(ptyId, handle)
  }

  /** The handle of the slept agent in this pane, which takes input as an idle agent does; null when
   *  the pane runs a process, never slept, or sleeps under the user's own Sleep. */
  sleptAgentHandleForPane(paneKey: string | null | undefined): string | null {
    const pane = paneKey ? parsePaneKey(paneKey) : null
    const leaf = pane ? this.leaves.get(this.getLeafKey(pane.tabId, pane.leafId)) : undefined
    if (!leaf) {
      // An unmounted pane answers to the handle its saved sleep record names.
      this.watchSleepingMail()
      const named = paneKey ? this.sleepingRecords.get(paneKey)?.terminalHandle : undefined
      return named && this.sleptAgentPaneForHandle(named)?.paneKey === paneKey ? named : null
    }
    const handle = this.sleptLeafHandle(leaf)
    return handle && this.sleptAgentPaneForHandle(handle) ? handle : null
  }

  /** The connected process a handle names; works for window panes, which own their handles, and for
   *  a resume into an unmounted pane, whose takeover left the name only on the resumed process. A
   *  handle record still on the stopped process is not awake until the takeover moves it. */
  protected wokenHandlePtyId(handle: string): string | null {
    const record = this.handles.get(handle)
    const ptyId = record ? record.ptyId : this.terminalIdentity.firstReversePtyId(handle)
    return ptyId && this.ptysById.get(ptyId)?.connected === true ? ptyId : null
  }
}
