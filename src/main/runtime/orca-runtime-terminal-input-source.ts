import type { RuntimeAgentPromptWriteOptions } from './runtime-terminal-contracts'
import type { RuntimeTerminalSend } from '../../shared/runtime-terminal-contracts'
import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import type { TerminalInputCaller, TerminalInputSource } from './terminal-input-source'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'

type StoredTerminalInputSource = Omit<TerminalInputSource, 'deviceName'> & {
  /** Position in this runtime's PTY write order; an older write never replaces a newer record. */
  sequence: number
}

type WrittenTerminalInput = { ptyId: string; sequence: number }

type TerminalInputSourceWriteOptions = {
  /** Who is sending; omitted for runtime-internal writes (orchestration, dispatch), which are not recorded. */
  inputSource?: TerminalInputCaller
}

export class OrcaRuntimeWithTerminalInputSource extends OrcaRuntimeWithResolveWaiter {
  private readonly terminalInputSourceByPtyId = new Map<string, StoredTerminalInputSource>()
  private terminalWriteSequence = 0

  /**
   * Next position in PTY write order. Take it inside a write hook, synchronously after the PTY
   * accepted the bytes, so overlapping sends settle by write order and not by completion order.
   */
  nextTerminalWriteSequence(): number {
    this.terminalWriteSequence += 1
    return this.terminalWriteSequence
  }

  /**
   * Remember which caller last wrote into a PTY. Call only after the PTY accepted the write.
   * Without a sequence the write is taken to be happening now, which is right for a caller that
   * has no hook into the write itself (the desktop renderer's IPC path).
   */
  recordTerminalInputSource(
    ptyId: string,
    caller: TerminalInputCaller,
    sequence: number = this.nextTerminalWriteSequence()
  ): void {
    // Why: sendTerminal records after its whole write resolved (chunks, the Enter delay, the
    // caller's own afterWrite), so an earlier write can reach this line after a later one did.
    const current = this.terminalInputSourceByPtyId.get(ptyId)
    if (current && current.sequence > sequence) {
      return
    }
    this.terminalInputSourceByPtyId.set(ptyId, {
      sequence,
      pairedDeviceId: caller.pairedDeviceId ?? null,
      // Why key on the device and not clientKind: the desktop renderer dispatches over IPC as
      // clientKind 'runtime' with no paired device, and so does the CLI over the unix socket.
      // Only a websocket client carries a paired device, so "no device" means this machine.
      clientKind: caller.pairedDeviceId ? (caller.clientKind ?? 'runtime') : 'local',
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
      pairedDeviceId: stored.pairedDeviceId,
      clientKind: stored.clientKind,
      at: stored.at,
      deviceName: stored.pairedDeviceId ? this.getPairedDeviceNameFn(stored.pairedDeviceId) : null
    }
  }

  // Why record from the write hooks and not from the caller: the handle is resolved to a PTY
  // inside the write, after the caller's own lookup and its awaits, so only the hook sees the
  // id that was actually written. Why after the call resolves and not inside the hook: the
  // writer fires the hook per chunk, and a later chunk or the Enter suffix can still be refused.
  // Why the sequence is taken inside the hook anyway: the writer calls afterWrite synchronously
  // after each accepted PTY write, so it is the one place that sees the true write order.
  override async sendTerminal(
    handle: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    options: RuntimeTerminalWriteOptions & TerminalInputSourceWriteOptions = {}
  ): Promise<RuntimeTerminalSend> {
    const { inputSource, ...writeOptions } = options
    if (!inputSource) {
      return super.sendTerminal(handle, action, writeOptions)
    }
    const written: { current: WrittenTerminalInput | null } = { current: null }
    const result = await super.sendTerminal(handle, action, {
      ...writeOptions,
      afterWrite: async (ptyId) => {
        written.current = { ptyId, sequence: this.nextTerminalWriteSequence() }
        await writeOptions.afterWrite?.(ptyId)
      }
    })
    if (result.accepted && written.current) {
      this.recordTerminalInputSource(written.current.ptyId, inputSource, written.current.sequence)
    }
    return result
  }

  // Why afterWrite here too: the prompt writer fires it after the paste and after the submit,
  // so the last one carries the submit's place in write order. The record is stored when the
  // prompt is reported accepted, either through the returned receipt or through
  // onInputAccepted, which an orchestration caller keeps as its accepted checkpoint even when
  // the later observation throws; both can run after a newer send has already recorded.
  override async sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions & TerminalInputSourceWriteOptions = {}
  ): Promise<RuntimeTerminalSend> {
    const { inputSource, ...writeOptions } = options
    if (!inputSource) {
      return super.sendTerminalAgentPrompt(handle, prompt, writeOptions)
    }
    const written: { current: WrittenTerminalInput | null } = { current: null }
    let recorded = false
    const record = (): void => {
      if (!recorded && written.current) {
        recorded = true
        this.recordTerminalInputSource(written.current.ptyId, inputSource, written.current.sequence)
      }
    }
    const result = await super.sendTerminalAgentPrompt(handle, prompt, {
      ...writeOptions,
      afterWrite: async (ptyId) => {
        written.current = { ptyId, sequence: this.nextTerminalWriteSequence() }
        await writeOptions.afterWrite?.(ptyId)
      },
      // Why unconditional: the checkpoint fires for any acceptQueued caller, with or without
      // a listener of its own, and it is the only signal left when the observation throws.
      onInputAccepted: (send: RuntimeTerminalSend) => {
        record()
        writeOptions.onInputAccepted?.(send)
      }
    })
    if (result.accepted) {
      record()
    }
    return result
  }

  // Why here: every PTY teardown path (exit, pruning, provider generation reset) ends in this
  // hook, and a replacement daemon session can reuse the PTY id.
  protected override disposePtyTitleTracker(ptyId: string): void {
    super.disposePtyTitleTracker(ptyId)
    this.terminalInputSourceByPtyId.delete(ptyId)
  }
}
