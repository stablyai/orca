import {
  decodeTerminalStreamFrame,
  type TerminalStreamFrame
} from '../../shared/terminal-stream-protocol'

type TerminalStreamHandler = (frame: TerminalStreamFrame) => void
type RawMessageHandler = (bytes: Uint8Array<ArrayBufferLike>) => void

export class RuntimeBinaryMessageRouter {
  private readonly terminalHandlers = new Map<string, Map<number, TerminalStreamHandler>>()
  private readonly rawHandlers = new Map<string, RawMessageHandler>()

  registerTerminalStream(
    connectionId: string | undefined,
    streamId: number,
    handler: TerminalStreamHandler
  ): () => void {
    if (!connectionId || !Number.isInteger(streamId) || streamId < 0) {
      return () => {}
    }
    if (this.rawHandlers.has(connectionId)) {
      throw new Error('binary_handler_mode_conflict')
    }
    let handlers = this.terminalHandlers.get(connectionId)
    if (!handlers) {
      handlers = new Map()
      this.terminalHandlers.set(connectionId, handlers)
    }
    handlers.set(streamId, handler)
    return () => {
      const current = this.terminalHandlers.get(connectionId)
      if (!current || current.get(streamId) !== handler) {
        return
      }
      current.delete(streamId)
      if (current.size === 0) {
        this.terminalHandlers.delete(connectionId)
      }
    }
  }

  registerRawMessage(connectionId: string | undefined, handler: RawMessageHandler): () => void {
    if (!connectionId) {
      return () => {}
    }
    if (this.rawHandlers.has(connectionId) || this.terminalHandlers.has(connectionId)) {
      throw new Error('binary_handler_mode_conflict')
    }
    this.rawHandlers.set(connectionId, handler)
    return () => {
      if (this.rawHandlers.get(connectionId) === handler) {
        this.rawHandlers.delete(connectionId)
      }
    }
  }

  dispatch(connectionId: string | undefined, bytes: Uint8Array<ArrayBufferLike>): void {
    if (!connectionId) {
      return
    }
    const rawHandler = this.rawHandlers.get(connectionId)
    if (rawHandler) {
      rawHandler(bytes)
      return
    }
    const frame = decodeTerminalStreamFrame(bytes)
    if (frame) {
      this.terminalHandlers.get(connectionId)?.get(frame.streamId)?.(frame)
    }
  }

  deleteConnection(connectionId: string): void {
    this.terminalHandlers.delete(connectionId)
    this.rawHandlers.delete(connectionId)
  }
}
