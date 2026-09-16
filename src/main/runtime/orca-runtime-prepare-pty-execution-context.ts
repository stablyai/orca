// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRegisterPty } from './orca-runtime-register-pty'
import type { TerminalOutputSourceRange } from '../../shared/terminal-output-source-range'
import type { RuntimePtyDataAdmission } from './runtime-terminal-contracts'

export class OrcaRuntimeWithPreparePtyExecutionContext extends OrcaRuntimeWithRegisterPty {
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
      this.earlyExitedPtyIncarnations.delete(ptyId)
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

  resetPtyModelAfterMigrationFailure(ptyId: string): void {
    this.providerSnapshotPreferredPtys.add(ptyId)
    this.disposeHeadlessTerminal(ptyId)
  }

  /**
   * Handles incoming data from a PTY process, running agent detection,
   * updating terminal tail buffers, and triggering foreground agent refreshes.
   */
  acceptPtyDataBounded(
    ptyId: string,
    data: string,
    at: number,
    sequenceChars = data.length,
    transformed = false,
    sourceRanges?: readonly TerminalOutputSourceRange[]
  ): RuntimePtyDataAdmission {
    let completion: Promise<void> | null = null
    const sequence = this.onPtyData(
      ptyId,
      data,
      at,
      sequenceChars,
      transformed,
      (receipt) => {
        completion = receipt
      },
      sourceRanges
    )
    if (!completion) {
      throw new Error('PTY model admission receipt was not captured')
    }
    return Object.freeze({ sequence, completion })
  }
}
