import type { TerminalInputCaller, TerminalInputSource } from '../../shared/terminal-input-source'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'

type StoredTerminalInputSource = Omit<TerminalInputSource, 'deviceName'>

export class OrcaRuntimeWithTerminalInputSource extends OrcaRuntimeWithResolveWaiter {
  private readonly terminalInputSourceByPtyId = new Map<string, StoredTerminalInputSource>()

  /** Remember which caller last wrote into a PTY. Call only after the write was accepted. */
  recordTerminalInputSource(ptyId: string, caller: TerminalInputCaller): void {
    this.terminalInputSourceByPtyId.set(ptyId, {
      pairedDeviceId: caller.pairedDeviceId ?? null,
      clientKind: caller.clientKind ?? 'local',
      at: Date.now()
    })
  }

  // Why resolve the name here and not at record time: a device can be renamed after it typed,
  // and the registry lives on the RPC server, which is constructed after this runtime.
  getTerminalInputSource(ptyId: string): TerminalInputSource | null {
    const stored = this.terminalInputSourceByPtyId.get(ptyId)
    if (!stored) {
      return null
    }
    return {
      ...stored,
      deviceName: stored.pairedDeviceId ? this.getPairedDeviceNameFn(stored.pairedDeviceId) : null
    }
  }

  // Why here: every PTY teardown path (exit, pruning, provider generation reset) ends in this
  // hook, and a replacement daemon session can reuse the PTY id.
  protected disposePtyTitleTracker(ptyId: string): void {
    super.disposePtyTitleTracker(ptyId)
    this.terminalInputSourceByPtyId.delete(ptyId)
  }
}
