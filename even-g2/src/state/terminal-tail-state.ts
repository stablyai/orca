// Unit 4: maps decoded terminal-stream frames into TerminalTailSlice (spec S8).
// Decoupled from Unit 3's concrete TerminalTailDecoder: accepts a minimal TailDecoder via
// constructor injection. Unit 8 (integrator) passes the real decoder instance.
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame
} from '@orca-shared/terminal-stream-protocol'
import type { HudStore } from './hud-store'
import type { RpcPort } from '../transport/orca-rpc-wire'

export type TailDecoder = {
  pushFrame(frame: TerminalStreamFrame): void
  lines(): string[]
}

export type TerminalTailInputs = {
  port: RpcPort
  createDecoder(): TailDecoder
  viewport?: { cols: number; rows: number }
}

const DEFAULT_VIEWPORT = { cols: 60, rows: 20 }

/** Opens/closes a terminal.subscribe stream and keeps store.terminalTail in sync. */
export class TerminalTailController {
  private unsubscribe: (() => void) | null = null
  private activeTerminalId: string | null = null

  constructor(
    private readonly store: HudStore,
    private readonly inputs: TerminalTailInputs
  ) {}

  open(terminalId: string): void {
    this.close()
    this.activeTerminalId = terminalId
    const decoder = this.inputs.createDecoder()

    this.store.update((s) => ({ ...s, terminalTail: { terminalId, lines: [], live: true } }))

    this.unsubscribe = this.inputs.port.subscribe(
      'terminal.subscribe',
      { terminal: terminalId, viewport: this.inputs.viewport ?? DEFAULT_VIEWPORT },
      () => {}, // JSON side-channel (metadata/acks) unused by v1's tail view
      (payload) => this.handleBinary(terminalId, decoder, payload)
    )
  }

  close(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.activeTerminalId = null
    this.store.update((s) =>
      s.terminalTail.terminalId === null
        ? s
        : { ...s, terminalTail: { terminalId: null, lines: [], live: false } }
    )
  }

  private handleBinary(terminalId: string, decoder: TailDecoder, payload: Uint8Array): void {
    if (this.activeTerminalId !== terminalId) {
      return
    } // subscription superseded by a later open()/close()
    const frame = decodeTerminalStreamFrame(payload)
    if (!frame) {
      return
    }
    decoder.pushFrame(frame)
    const live = frame.opcode !== TerminalStreamOpcode.Error
    this.store.update((s) =>
      s.terminalTail.terminalId === terminalId
        ? { ...s, terminalTail: { terminalId, lines: decoder.lines(), live } }
        : s
    )
  }
}
