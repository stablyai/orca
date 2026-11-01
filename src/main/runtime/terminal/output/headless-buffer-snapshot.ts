import { OrcaRuntimeWithVisibleSnapshotPreview } from './terminal-visible-state'
import type { TerminalOscLinkRange } from '../../../../shared/terminal-osc-link-ranges'
import { parseTerminalKittyKeyboardFlags } from '../../../../shared/terminal-kitty-keyboard-flags'
import type {
  OrchestrationCompatibilitySshAttachmentAuthority,
  OrchestrationCompatibilitySshTerminal
} from '../../runtime-terminal-contracts'
import { randomUUID } from 'node:crypto'

export abstract class OrcaRuntimeWithSerializeHeadlessTerminalBuffer extends OrcaRuntimeWithVisibleSnapshotPreview {
  /** Keyed by the attachment that carries each one, so releasing it forgets the terminal. */
  protected readonly orchestrationCompatibilitySshTerminals = new Map<
    string,
    OrchestrationCompatibilitySshTerminal
  >()

  protected abstract getLeafKey(tabId: string, leafId: string): string

  protected async serializeHeadlessTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number; includeEmpty?: boolean } = {}
  ): Promise<{
    data: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    scrollbackAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
    // Restore dangling escapes last, after resets, so the next live chunk completes them (#7329).
    pendingEscapeTailAnsi?: string
  } | null> {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return null
    }
    await state.writeChain
    await state.ownership.settle()
    // Why: normal history is separated from an active alternate frame, so the
    // caller's scrollback policy can be honored without painting it into alt.
    const scrollbackRows = opts.scrollbackRows ?? 0
    const snapshot = state.emulator.getSnapshot({ scrollbackRows })
    const terminalOwner = state.ownership.owner
    const data = snapshot.rehydrateSequences + snapshot.snapshotAnsi
    return data.length > 0 || opts.includeEmpty === true
      ? this.preferTrackedLastTitle(ptyId, {
          data,
          frameRestoreAnsi: snapshot.frameRestoreAnsi,
          cols: snapshot.cols,
          rows: snapshot.rows,
          cwd: snapshot.cwd ?? this.terminalCwdByPtyId.get(ptyId),
          lastTitle: snapshot.lastTitle,
          seq: state.outputSequence,
          source: 'headless' as const,
          oscLinks: snapshot.oscLinks,
          scrollbackAnsi: snapshot.scrollbackAnsi,
          // Capture flags at the image's stream position to prevent duplicate/out-of-order replay pushes and pops.
          ...(parseTerminalKittyKeyboardFlags(snapshot.modes?.kittyKeyboardFlags) !== undefined
            ? { kittyKeyboardFlags: snapshot.modes.kittyKeyboardFlags }
            : {}),
          ...(snapshot.pendingEscapeTailAnsi
            ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
            : {}),
          ...(terminalOwner ? { terminalOwner } : {}),
          // Alt snapshots must preserve xterm history used for TUI scroll-up after tab return.
          alternateScreen: snapshot.modes?.alternateScreen ?? state.emulator.isAlternateScreen,
          // Do not fold into data: the restorer's later reset would abort this partial escape.
          pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi
        })
      : null
  }

  protected disposeHeadlessTerminal(ptyId: string): void {
    this.headlessHydrationState.delete(ptyId)
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    this.headlessTerminals.delete(ptyId)
    // Sever reply forwarding before queued writes finish so reused PTY ids cannot receive stale replies.
    state.emulator.disableQueryReplyForwarding()
    state.ownership.dispose()
    state.writeChain.finally(() => state.emulator.dispose()).catch(() => state.emulator.dispose())
  }

  resolveLeafForHandle(handle: string): { ptyId: string | null } | null {
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    if (record.tabId.startsWith('pty:')) {
      return { ptyId: record.ptyId }
    }
    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf) {
      return null
    }
    return { ptyId: leaf.ptyId }
  }

  // Concrete-PTY handles cannot adopt later pane occupants; only pre-spawn handles may bind their first PTY (#7718).
  resolveLiveLeafForHandle(handle: string): { ptyId: string | null } | null {
    // Repair runtime-owned handles cleared by renderer reload before reading their records.
    this.getLivePtyForHandle(handle)
    const record = this.handles.get(handle)
    if (!record) {
      return null
    }
    if (record.tabId.startsWith('pty:')) {
      return { ptyId: record.ptyId }
    }
    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf) {
      return null
    }
    if (
      record.ptyId !== null &&
      (leaf.ptyId !== record.ptyId || leaf.ptyGeneration !== record.ptyGeneration)
    ) {
      throw new Error('terminal_handle_stale')
    }
    return { ptyId: leaf.ptyId }
  }

  getOrchestrationCompatibilityHostId(): 'local' {
    return 'local'
  }

  registerOrchestrationCompatibilitySshAttachment(
    targetId: string,
    connectionIncarnation: string,
    terminal?: OrchestrationCompatibilitySshTerminal
  ): OrchestrationCompatibilitySshAttachmentAuthority {
    const authority = Object.freeze({
      kind: 'ssh' as const,
      targetId,
      connectionIncarnation,
      attachmentId: randomUUID()
    })
    this.orchestrationCompatibilitySshAttachments.set(authority.attachmentId, authority)
    if (terminal) {
      this.orchestrationCompatibilitySshTerminals.set(
        authority.attachmentId,
        Object.freeze({ ...terminal })
      )
    }
    return authority
  }

  releaseOrchestrationCompatibilitySshAttachment(attachmentId: string): void {
    this.orchestrationCompatibilitySshAttachments.delete(attachmentId)
    this.orchestrationCompatibilitySshTerminals.delete(attachmentId)
  }

  /**
   * Only while an attachment holds it, and only for a handle this runtime does not host. Two hosts
   * claiming one handle name nobody: neither may borrow the other's pane or process.
   */
  protected getOrchestrationCompatibilitySshTerminal(
    handle: string
  ): OrchestrationCompatibilitySshTerminal | undefined {
    let found: { targetId: string; terminal: OrchestrationCompatibilitySshTerminal } | undefined
    for (const [attachmentId, terminal] of this.orchestrationCompatibilitySshTerminals) {
      const targetId = this.orchestrationCompatibilitySshAttachments.get(attachmentId)?.targetId
      if (terminal.handle !== handle || !targetId) {
        continue
      }
      if (
        found &&
        (found.targetId !== targetId ||
          found.terminal.paneKey !== terminal.paneKey ||
          found.terminal.processIncarnation !== terminal.processIncarnation)
      ) {
        return undefined
      }
      found = { targetId, terminal }
    }
    return found?.terminal
  }
}
