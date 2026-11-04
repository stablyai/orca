import { OrcaRuntimeWithGetPtyRecordForPaneKey } from './terminal-pane-mail-routing'
import type { OrchestrationMailboxTerminal } from './mailbox-owner'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import { parsePaneKey } from '../../../shared/stable-pane-id'

/** Which live terminal orchestration types mail into, and the handle it is known by. */
export abstract class OrcaRuntimeWithMailboxTerminalIdentity extends OrcaRuntimeWithGetPtyRecordForPaneKey {
  protected getMailboxTerminalForPaneKey(paneKey: string): OrchestrationMailboxTerminal | null {
    const pty = this.getPtyRecordForPaneKey(paneKey)
    return pty ? this.getOrchestrationMailboxTerminal(pty.ptyId) : null
  }

  /** The terminal orchestration points at its mail, whether or not a window pane shows it. */
  protected getOrchestrationMailboxTerminal(ptyId: string): OrchestrationMailboxTerminal | null {
    const pty = this.ptysById.get(ptyId)
    // Never issue here: a PTY awaiting its handle inventory gets mail once the exported handle is adopted.
    const handle = pty?.connected ? this.getTerminalHandleForPty(ptyId) : undefined
    return pty && handle ? this.buildOrchestrationMailboxTerminal(handle, pty) : null
  }

  protected getOrchestrationMailboxTerminalForHandle(
    handle: string
  ): OrchestrationMailboxTerminal | null {
    try {
      const { pty } = this.getTerminalPtyForHandle(handle)
      return pty.connected ? this.buildOrchestrationMailboxTerminal(handle, pty) : null
    } catch {
      return null
    }
  }

  private buildOrchestrationMailboxTerminal(
    handle: string,
    pty: RuntimePtyWorktreeRecord
  ): OrchestrationMailboxTerminal | null {
    const paneKeys = this.getMailboxPaneKeysForPty(pty)
    const { ptyId, lastAgentStatus, lastAgentStatusObservedLive } = pty
    return paneKeys.length > 0
      ? { ptyId, handle, paneKeys, lastAgentStatus, lastAgentStatusObservedLive }
      : null
  }

  /** The handle a terminal is known by: its own, else the one its window pane issued. */
  private getTerminalHandleForPty(ptyId: string): string | undefined {
    const handle =
      this.handleByPtyId.get(ptyId) ??
      this.handleByPtyIncarnation.get(ptyId)?.handle ??
      this.getLeavesForPty(ptyId)
        .map((leaf) => this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId)))
        .find((leafHandle) => leafHandle !== undefined)
    // A reload clears records but not the PTY's own handle; naming it needs no record repair.
    const unrecordedOwn =
      handle !== undefined && !this.handles.has(handle) && handle === this.handleByPtyId.get(ptyId)
    try {
      return handle && (unrecordedOwn || this.getTerminalPtyForHandle(handle).pty.ptyId === ptyId)
        ? handle
        : undefined
    } catch {
      return undefined
    }
  }

  /** The panes Runs and Dispatches bind this terminal by: every window pane showing it, else the
   *  pane it records, unless another terminal holds or shares that pane (then no mail is typed). */
  private getMailboxPaneKeysForPty(pty: RuntimePtyWorktreeRecord): string[] {
    const shownIn = this.getLeavesForPty(pty.ptyId)
    if (shownIn.length > 0) {
      return shownIn.map((leaf) => `${leaf.tabId}:${leaf.leafId}`)
    }
    const { paneKey } = this.paneOfPty(pty)
    const pane = parsePaneKey(paneKey ?? '')
    if (!paneKey || (pane && this.leaves.get(this.getLeafKey(pane.tabId, pane.leafId))?.ptyId)) {
      return []
    }
    // A retained predecessor and its replacement can both claim a pane no window shows.
    for (const other of this.ptysById.values()) {
      if (other !== pty && other.connected && this.paneOfPty(other).paneKey === paneKey) {
        return []
      }
    }
    return [paneKey]
  }
}
