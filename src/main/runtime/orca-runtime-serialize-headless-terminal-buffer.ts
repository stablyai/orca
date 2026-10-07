// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithVisibleSnapshotPreview } from './orca-runtime-visible-snapshot-preview'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import { parseTerminalKittyKeyboardFlags } from '../../shared/terminal-kitty-keyboard-flags'
import type { OrchestrationCompatibilitySshAttachmentAuthority } from './runtime-terminal-contracts'
import { randomUUID } from 'node:crypto'

export class OrcaRuntimeWithSerializeHeadlessTerminalBuffer extends OrcaRuntimeWithVisibleSnapshotPreview {
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
    // Why: dangling mid-escape tail the restorer must write LAST, after any
    // reset, so the next live chunk completes it instead of rendering it
    // literally (Bug E / #7329).
    pendingEscapeTailAnsi?: string
  } | null> {
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return null
    }
    const emulator = state.emulator
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const incarnation = this.ptysById.get(ptyId)?.incarnationId
    const isCurrent = (): boolean =>
      this.headlessTerminals.get(ptyId) === state &&
      state.emulator === emulator &&
      this.getPtyLifecycleGeneration(ptyId) === generation &&
      this.ptysById.get(ptyId)?.incarnationId === incarnation
    // Arrival-time metadata can advance while later bytes remain queued.
    const fallback = this.preferTrackedLastTitle(ptyId, {
      cwd: this.terminalCwdByPtyId.get(ptyId),
      lastTitle: undefined
    })
    // Reserve the same queue as output and resize, including ownership settlement.
    const completion = state.writeChain.then(async () => {
      if (!isCurrent()) {
        return null
      }
      await state.ownership.settle()
      if (!isCurrent()) {
        return null
      }
      // Why: normal history is separated from an active alternate frame, so the
      // caller's scrollback policy can be honored without painting it into alt.
      const scrollbackRows = opts.scrollbackRows ?? 0
      const snapshot = state.emulator.getSnapshot({ scrollbackRows })
      const terminalOwner = state.ownership.owner
      const data = snapshot.rehydrateSequences + snapshot.snapshotAnsi
      return data.length > 0 || opts.includeEmpty === true
        ? {
            data,
            frameRestoreAnsi: snapshot.frameRestoreAnsi,
            cols: snapshot.cols,
            rows: snapshot.rows,
            cwd: snapshot.cwd ?? fallback.cwd,
            lastTitle: fallback.lastTitle ?? snapshot.lastTitle,
            seq: state.outputSequence,
            source: 'headless' as const,
            oscLinks: snapshot.oscLinks,
            scrollbackAnsi: snapshot.scrollbackAnsi,
            // Why beside outputSequence and never re-read later: the flags must
            // describe the same stream position as the image, or replay would
            // apply push/pop transitions twice or out of order.
            ...(parseTerminalKittyKeyboardFlags(snapshot.modes?.kittyKeyboardFlags) !== undefined
              ? { kittyKeyboardFlags: snapshot.modes.kittyKeyboardFlags }
              : {}),
            ...(snapshot.pendingEscapeTailAnsi
              ? { pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi }
              : {}),
            ...(terminalOwner ? { terminalOwner } : {}),
            // Why: lets the renderer skip the destructive scrollback clear when
            // restoring an alt-screen snapshot — clearing wipes xterm's own
            // history that the TUI relies on for scroll-up after a tab return.
            alternateScreen: snapshot.modes?.alternateScreen ?? state.emulator.isAlternateScreen,
            // Why NOT folded into data: the renderer writes its post-replay
            // reset after data, and any ESC after a dangling partial aborts it.
            // The restorer writes this last (Bug E fix).
            pendingEscapeTailAnsi: snapshot.pendingEscapeTailAnsi
          }
        : null
    })
    // Return capture errors to the caller while keeping later stream work runnable.
    state.writeChain = completion.then(
      () => {},
      () => {}
    )
    return completion
  }

  protected disposeHeadlessTerminal(ptyId: string): void {
    this.headlessHydrationState.delete(ptyId)
    const state = this.headlessTerminals.get(ptyId)
    if (!state) {
      return
    }
    this.headlessTerminals.delete(ptyId)
    // Why: queued chain links still parse below before the emulator disposes;
    // sever the reply sink now so they cannot write to a respawned PTY that
    // reused this id (belt to the sink's state-identity check).
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

  // Why: remote clients hold handles across transport reconnects. A handle
  // minted for a concrete PTY must never silently adopt a different PTY that
  // later occupies the same pane — that misroutes keystrokes (#7718). Handles
  // still awaiting their first PTY (ptyId null) may adopt it, which preserves
  // the mobile pre-spawn subscribe flow.
  resolveLiveLeafForHandle(handle: string): { ptyId: string | null } | null {
    // Why the discarded call: it re-links a runtime-owned handle whose `handles` record a renderer
    // reload cleared, so the lookup below sees it; without it a phone's held handle inspects nothing.
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
    connectionIncarnation: string
  ): OrchestrationCompatibilitySshAttachmentAuthority {
    const authority = Object.freeze({
      kind: 'ssh' as const,
      targetId,
      connectionIncarnation,
      attachmentId: randomUUID()
    })
    this.orchestrationCompatibilitySshAttachments.set(authority.attachmentId, authority)
    return authority
  }

  releaseOrchestrationCompatibilitySshAttachment(attachmentId: string): void {
    this.orchestrationCompatibilitySshAttachments.delete(attachmentId)
  }
}
