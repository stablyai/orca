import { OrcaRuntimeWithRegisterPty } from '../lifecycle/pty-registration'

export abstract class OrcaRuntimeWithPreparePtyExecutionContext extends OrcaRuntimeWithRegisterPty {
  protected abstract disposeHeadlessTerminal(ptyId: string): void

  protected abstract replaceHeadlessTerminalAfterExecutionContextChange(ptyId: string): void

  preparePtyExecutionContext(
    ptyId: string,
    wslDistro: string | null,
    options: { resetIncarnation?: boolean; preserveExisting?: boolean } = {}
  ): boolean {
    const pty = this.ptysById.get(ptyId)
    const hadExistingContext = this.wslDistroByPtyId.has(ptyId) || pty !== undefined
    if (options.preserveExisting && hadExistingContext) {
      // Why: attach-time settings are only a fallback; a live PTY's recorded
      // execution namespace remains authoritative until its provider replies.
      return false
    }

    if (options.resetIncarnation) {
      // Why: an explicit new lifecycle supersedes an unidentifiable exit from the reused PTY id.
      this.pendingPtyRegistrationIncarnations.get(ptyId)?.exitedIncarnations.clear()
      this.disposeHeadlessTerminal(ptyId)
      this.osc7ScanTailByPtyId.delete(ptyId)
      this.terminalCwdByPtyId.delete(ptyId)
      this.terminalFileUriHostnameByPtyId.delete(ptyId)
      this.wslDistroByPtyId.delete(ptyId)
    }

    const previous = this.wslDistroByPtyId.get(ptyId) ?? null
    if (wslDistro) {
      this.wslDistroByPtyId.set(ptyId, wslDistro)
    } else {
      this.wslDistroByPtyId.delete(ptyId)
    }
    if (pty) {
      pty.wslDistro = wslDistro
    }
    if (!options.resetIncarnation && previous !== wslDistro && this.headlessTerminals.has(ptyId)) {
      // Why: bytes parsed with two distro namespaces would leave an internally
      // inconsistent CWD; rebuild from the provider's authoritative snapshot.
      this.terminalCwdByPtyId.delete(ptyId)
      this.replaceHeadlessTerminalAfterExecutionContextChange(ptyId)
    }
    return options.resetIncarnation === true || !hadExistingContext || previous !== wslDistro
  }

  /** Record the spawn launch command so the per-PTY Command Code detector can
   *  arm from it (renderer startupCommand parity). Best-effort: a chunk that
   *  beats this call falls back to the detector's banner arming. */
  noteTerminalSpawnCommand(ptyId: string, command: string | null | undefined): void {
    const trimmed = typeof command === 'string' ? command.trim() : ''
    if (trimmed.length > 0) {
      this.terminalSpawnCommandsByPtyId.set(ptyId, trimmed)
    }
  }
}
