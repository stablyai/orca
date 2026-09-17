import type { RuntimeAgentPromptWriteOptions } from './runtime-terminal-contracts'
import type { RuntimeTerminalSend } from '../../shared/runtime-terminal-contracts'
import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import type { TerminalInputCaller, TerminalInputSource } from './terminal-input-source'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'

type StoredTerminalInputSource = Omit<TerminalInputSource, 'deviceName'>

type TerminalInputSourceWriteOptions = {
  /** Who is sending; omitted for runtime-internal writes (orchestration, dispatch), which are not recorded. */
  inputSource?: TerminalInputCaller
}

export class OrcaRuntimeWithTerminalInputSource extends OrcaRuntimeWithResolveWaiter {
  private readonly terminalInputSourceByPtyId = new Map<string, StoredTerminalInputSource>()

  /** Remember which caller last wrote into a PTY. Call only after the PTY accepted the write. */
  recordTerminalInputSource(ptyId: string, caller: TerminalInputCaller): void {
    this.terminalInputSourceByPtyId.set(ptyId, {
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
      ...stored,
      deviceName: stored.pairedDeviceId ? this.getPairedDeviceNameFn(stored.pairedDeviceId) : null
    }
  }

  // Why record from the write hooks and not from the caller: the handle is resolved to a PTY
  // inside the write, after the caller's own lookup and its awaits, so only the hook sees the
  // id that was actually written. Why after the call resolves and not inside the hook: the
  // writer fires the hook per chunk, and a later chunk or the Enter suffix can still be refused.
  override async sendTerminal(
    handle: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    options: RuntimeTerminalWriteOptions & TerminalInputSourceWriteOptions = {}
  ): Promise<RuntimeTerminalSend> {
    const { inputSource, ...writeOptions } = options
    if (!inputSource) {
      return super.sendTerminal(handle, action, writeOptions)
    }
    let writtenPtyId: string | null = null
    const result = await super.sendTerminal(handle, action, {
      ...writeOptions,
      afterWrite: async (ptyId) => {
        writtenPtyId = ptyId
        await writeOptions.afterWrite?.(ptyId)
      }
    })
    if (result.accepted && writtenPtyId) {
      this.recordTerminalInputSource(writtenPtyId, inputSource)
    }
    return result
  }

  // Why beforeWrite here: the agent prompt writer has no afterWrite hook, so the PTY id is
  // taken from the last pre-write hook. It is recorded when the prompt is reported accepted,
  // either through the returned receipt or through onInputAccepted, which an orchestration
  // caller keeps as its accepted checkpoint even when the later observation throws.
  override async sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: RuntimeAgentPromptWriteOptions & TerminalInputSourceWriteOptions = {}
  ): Promise<RuntimeTerminalSend> {
    const { inputSource, ...writeOptions } = options
    if (!inputSource) {
      return super.sendTerminalAgentPrompt(handle, prompt, writeOptions)
    }
    let writtenPtyId: string | null = null
    let recorded = false
    const record = (): void => {
      if (!recorded && writtenPtyId) {
        recorded = true
        this.recordTerminalInputSource(writtenPtyId, inputSource)
      }
    }
    const result = await super.sendTerminalAgentPrompt(handle, prompt, {
      ...writeOptions,
      beforeWrite: async (ptyId) => {
        writtenPtyId = ptyId
        await writeOptions.beforeWrite?.(ptyId)
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
