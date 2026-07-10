import type { Socket } from 'node:net'

export type BackpressuredStreamLine = {
  sessionId: string
  line: string
  priority?: boolean
}

type BackpressuredStreamWrites = {
  socket: Socket
  lines: BackpressuredStreamLine[]
  queuedBytes: number
  onDrain: () => void
  onClose: () => void
}

export type WriteStreamLinesOptions = {
  prioritizeBackpressuredSession?: boolean
}

export class BackpressuredStreamWriteQueue {
  private byClient = new Map<string, BackpressuredStreamWrites>()
  private maxQueuedBytes: number

  constructor(maxQueuedBytes: number) {
    this.maxQueuedBytes = Math.max(1, maxQueuedBytes)
  }

  clientIds(): Iterable<string> {
    return this.byClient.keys()
  }

  write(
    clientId: string,
    streamSocket: Socket,
    lines: BackpressuredStreamLine[],
    opts: WriteStreamLinesOptions = {}
  ): void {
    // Why: a write aimed at a destroyed socket (a stale reference held across a
    // reconnect) must not clear the live client's queue or register drain
    // listeners that can never fire; the frame is dropped instead.
    if (streamSocket.destroyed) {
      return
    }
    const existing = this.byClient.get(clientId)
    if (existing) {
      if (existing.socket === streamSocket && !streamSocket.destroyed) {
        this.appendLines(existing, lines, opts)
        return
      }
      this.clear(clientId)
    }

    for (let index = 0; index < lines.length; index += 1) {
      // Why: only Node's explicit `false` return signals backpressure; duck-typed
      // sockets in tests or wrappers may return undefined and must keep the
      // legacy direct-write path.
      if (streamSocket.write(lines[index].line) === false) {
        this.deferUntilDrain(clientId, streamSocket, lines.slice(index + 1))
        return
      }
    }
  }

  clear(clientId: string): void {
    const pending = this.byClient.get(clientId)
    if (!pending) {
      return
    }
    this.byClient.delete(clientId)
    pending.socket.off('drain', pending.onDrain)
    pending.socket.off('close', pending.onClose)
    pending.socket.off('error', pending.onClose)
  }

  private deferUntilDrain(
    clientId: string,
    streamSocket: Socket,
    lines: BackpressuredStreamLine[]
  ): void {
    const onDrain = (): void => {
      const pending = this.byClient.get(clientId)
      if (!pending || pending.socket !== streamSocket) {
        return
      }
      this.byClient.delete(clientId)
      streamSocket.off('close', pending.onClose)
      streamSocket.off('error', pending.onClose)
      if (!streamSocket.destroyed) {
        this.write(clientId, streamSocket, pending.lines)
      }
    }
    const onClose = (): void => {
      this.clear(clientId)
    }

    const pending: BackpressuredStreamWrites = {
      socket: streamSocket,
      lines: [],
      queuedBytes: 0,
      onDrain,
      onClose
    }
    this.appendLines(pending, lines)
    this.byClient.set(clientId, pending)
    streamSocket.once('drain', onDrain)
    streamSocket.once('close', onClose)
    streamSocket.once('error', onClose)
  }

  private appendLines(
    pending: BackpressuredStreamWrites,
    lines: BackpressuredStreamLine[],
    opts: WriteStreamLinesOptions = {}
  ): void {
    if (opts.prioritizeBackpressuredSession && lines.length > 0) {
      // Why: input-triggered daemon output should not sit behind an unrelated
      // hidden-output flood once the socket drains, but each session's bytes
      // must still keep their own order.
      const sessionId = lines[0].sessionId
      let lastSameSessionIndex = -1
      for (let index = pending.lines.length - 1; index >= 0; index -= 1) {
        if (pending.lines[index].sessionId === sessionId) {
          lastSameSessionIndex = index
          break
        }
      }
      if (lastSameSessionIndex >= 0) {
        pending.lines.splice(lastSameSessionIndex + 1, 0, ...lines)
      } else {
        const firstNonPriorityIndex = pending.lines.findIndex((line) => !line.priority)
        pending.lines.splice(
          firstNonPriorityIndex === -1 ? pending.lines.length : firstNonPriorityIndex,
          0,
          ...lines
        )
      }
    } else {
      pending.lines.push(...lines)
    }
    pending.queuedBytes += this.measureLinesBytes(lines)
    // Why: a wedged stream socket can otherwise retain unbounded hidden-output
    // floods below the renderer ACK budget. Preserve the newest bounded tail.
    // The sole remaining line is never dropped, so the effective bound is
    // maxQueuedBytes plus at most one frame (frames are <= the NDJSON line cap).
    while (pending.queuedBytes > this.maxQueuedBytes && pending.lines.length > 1) {
      const dropIndex = pending.lines.findIndex((line) => !line.priority)
      const [dropped] = pending.lines.splice(dropIndex === -1 ? 0 : dropIndex, 1)
      pending.queuedBytes -= dropped ? this.measureLineBytes(dropped) : 0
    }
  }

  private measureLinesBytes(lines: BackpressuredStreamLine[]): number {
    let bytes = 0
    for (const line of lines) {
      bytes += this.measureLineBytes(line)
    }
    return bytes
  }

  private measureLineBytes(line: BackpressuredStreamLine): number {
    return Buffer.byteLength(line.line, 'utf8')
  }
}
