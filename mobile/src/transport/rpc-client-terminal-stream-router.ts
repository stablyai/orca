import {
  handleTerminalBinaryFrame,
  type TerminalSnapshotState
} from './rpc-client-terminal-binary-frame'

type TerminalListener = (result: unknown) => void

export class RpcClientTerminalStreamRouter {
  private readonly listeners = new Map<number, TerminalListener>()
  private readonly idsByRequest = new Map<string, Set<number>>()
  private readonly snapshots = new Map<number, TerminalSnapshotState>()

  register(requestId: string, streamId: number, listener: TerminalListener): void {
    const ids = this.idsByRequest.get(requestId) ?? new Set<number>()
    this.idsByRequest.set(requestId, ids)
    ids.add(streamId)
    this.listeners.set(streamId, listener)
  }

  reset(requestId: string): void {
    const streamIds = this.idsByRequest.get(requestId)
    if (!streamIds) {
      return
    }
    for (const streamId of streamIds) {
      this.listeners.delete(streamId)
      this.snapshots.delete(streamId)
    }
    this.idsByRequest.delete(requestId)
  }

  handle(bytes: Uint8Array): void {
    handleTerminalBinaryFrame(bytes, {
      terminalSnapshots: this.snapshots,
      getListener: (streamId) => this.listeners.get(streamId)
    })
  }
}
