import {
  encodeTerminalStreamFrame,
  encodeTerminalStreamText,
  TerminalStreamOpcode
} from './terminal-stream-protocol'

export type TerminalInputSendResult = 'sent' | 'no-stream' | 'failed'

export function terminalHandleFromSubscribeParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') {
    return null
  }
  const terminal = (params as { terminal?: unknown }).terminal
  return typeof terminal === 'string' ? terminal : null
}

export function rememberTerminalInputStream(
  streams: Map<string, number>,
  terminal: string,
  streamId: number
): void {
  streams.set(terminal, streamId)
}

export function forgetTerminalInputStream(
  streams: Map<string, number>,
  terminal: string | null,
  streamId: number
): void {
  if (terminal && streams.get(terminal) === streamId) {
    streams.delete(terminal)
  }
}

export function encodeTerminalInputFrame(streamId: number, text: string): Uint8Array {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Input,
    streamId,
    seq: 0,
    payload: encodeTerminalStreamText(text)
  })
}

export function sendRememberedTerminalInput(args: {
  streams: ReadonlyMap<string, number>
  terminal: string
  text: string
  connected: boolean
  sendBinary: (bytes: Uint8Array) => boolean
}): TerminalInputSendResult {
  if (!args.connected) {
    return 'failed'
  }
  const streamId = args.streams.get(args.terminal)
  if (streamId === undefined) {
    return 'no-stream'
  }
  return args.sendBinary(encodeTerminalInputFrame(streamId, args.text)) ? 'sent' : 'failed'
}

export class TerminalInputStreamRegistry {
  private readonly streams = new Map<string, number>()

  remember(params: unknown, streamId: number): void {
    const terminal = terminalHandleFromSubscribeParams(params)
    if (terminal) {
      rememberTerminalInputStream(this.streams, terminal, streamId)
    }
  }

  forget(params: unknown, streamIds: Iterable<number>): void {
    const terminal = terminalHandleFromSubscribeParams(params)
    for (const streamId of streamIds) {
      forgetTerminalInputStream(this.streams, terminal, streamId)
    }
  }

  clear(): void {
    this.streams.clear()
  }

  send(
    terminal: string,
    text: string,
    connected: boolean,
    sendBinary: (bytes: Uint8Array) => boolean
  ): TerminalInputSendResult {
    return sendRememberedTerminalInput({
      streams: this.streams,
      terminal,
      text,
      connected,
      sendBinary
    })
  }
}
