import type { Socket } from 'node:net'

export type DaemonBackpressuredStreamLine = {
  sessionId: string
  line: string
  priority: boolean
}

type BackpressuredStreamWrites = {
  socket: Socket
  lines: DaemonBackpressuredStreamLine[]
  queuedBytes: number
  onDrain: () => void
  onClose: () => void
}

const DEFAULT_MAX_BACKPRESSURED_STREAM_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_BACKPRESSURED_STREAM_LINES = 8_192

export type DaemonStreamBackpressureQueueOptions = {
  maxBackpressuredBytes?: number
  maxBackpressuredLines?: number
}

export class DaemonStreamBackpressureQueue {
  private backpressuredByClient = new Map<string, BackpressuredStreamWrites>()
  private maxBackpressuredBytes: number
  private maxBackpressuredLines: number

  constructor(options: DaemonStreamBackpressureQueueOptions = {}) {
    this.maxBackpressuredBytes = Math.max(
      1,
      options.maxBackpressuredBytes ?? DEFAULT_MAX_BACKPRESSURED_STREAM_BYTES
    )
    this.maxBackpressuredLines = Math.max(
      1,
      Math.floor(options.maxBackpressuredLines ?? DEFAULT_MAX_BACKPRESSURED_STREAM_LINES)
    )
  }

  clientIds(): Iterable<string> {
    return this.backpressuredByClient.keys()
  }

  writeLines(
    clientId: string,
    streamSocket: Socket,
    lines: DaemonBackpressuredStreamLine[],
    options: { priority?: boolean } = {}
  ): void {
    const existing = this.backpressuredByClient.get(clientId)
    if (existing) {
      if (existing.socket === streamSocket && !streamSocket.destroyed) {
        this.appendBackpressuredLines(existing, lines, options)
        return
      }
      this.clear(clientId)
    }

    for (let index = 0; index < lines.length; index += 1) {
      const accepted = streamSocket.write(lines[index].line)
      if (accepted === false) {
        this.deferUntilDrain(clientId, streamSocket, lines.slice(index + 1))
        return
      }
    }
  }

  clear(clientId: string): void {
    const pending = this.backpressuredByClient.get(clientId)
    if (!pending) {
      return
    }
    this.backpressuredByClient.delete(clientId)
    pending.socket.off('drain', pending.onDrain)
    pending.socket.off('close', pending.onClose)
    pending.socket.off('error', pending.onClose)
  }

  private deferUntilDrain(
    clientId: string,
    streamSocket: Socket,
    lines: DaemonBackpressuredStreamLine[]
  ): void {
    const onDrain = (): void => {
      const pending = this.backpressuredByClient.get(clientId)
      if (!pending || pending.socket !== streamSocket) {
        return
      }
      this.backpressuredByClient.delete(clientId)
      streamSocket.off('close', pending.onClose)
      streamSocket.off('error', pending.onClose)
      if (!streamSocket.destroyed) {
        this.writeLines(clientId, streamSocket, pending.lines)
      }
    }
    const onClose = (): void => this.clear(clientId)
    const pending: BackpressuredStreamWrites = {
      socket: streamSocket,
      lines: [],
      queuedBytes: 0,
      onDrain,
      onClose
    }
    this.backpressuredByClient.set(clientId, pending)
    streamSocket.once('drain', onDrain)
    streamSocket.once('close', onClose)
    streamSocket.once('error', onClose)
    this.appendBackpressuredLines(pending, lines)
  }

  private appendBackpressuredLines(
    pending: BackpressuredStreamWrites,
    lines: DaemonBackpressuredStreamLine[],
    options: { priority?: boolean } = {}
  ): void {
    if (options.priority === true && lines.length > 0) {
      // Why: input-triggered daemon output should not sit behind an unrelated
      // hidden-output flood once the socket drains, while same-session bytes
      // keep their original order.
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
        const firstBackgroundIndex = pending.lines.findIndex((line) => !line.priority)
        pending.lines.splice(
          firstBackgroundIndex === -1 ? pending.lines.length : firstBackgroundIndex,
          0,
          ...lines
        )
      }
    } else {
      pending.lines.push(...lines)
    }
    pending.queuedBytes += this.measureLinesBytes(lines)
    this.trimToBudget(pending)
  }

  private trimToBudget(pending: BackpressuredStreamWrites): void {
    if (
      pending.lines.length <= this.maxBackpressuredLines &&
      pending.queuedBytes <= this.maxBackpressuredBytes
    ) {
      return
    }

    let queuedBytes = pending.queuedBytes
    let lineCount = pending.lines.length
    const backgroundTrim: { line: DaemonBackpressuredStreamLine; bytes: number }[] = []

    // Why: drop oldest background work first while scanning once. Priority
    // output still stays bounded by the second pass if it alone exceeds caps.
    for (const line of pending.lines) {
      const bytes = this.measureLineBytes(line)
      const overLineBudget = lineCount > this.maxBackpressuredLines
      const overByteBudget = queuedBytes > this.maxBackpressuredBytes
      if (lineCount > 1 && !line.priority && (overLineBudget || overByteBudget)) {
        queuedBytes -= bytes
        lineCount -= 1
        continue
      }
      backgroundTrim.push({ line, bytes })
    }

    const retained: DaemonBackpressuredStreamLine[] = []
    let retainedBytes = 0
    for (const entry of backgroundTrim) {
      const overLineBudget = lineCount > this.maxBackpressuredLines
      const overByteBudget = queuedBytes > this.maxBackpressuredBytes
      if (lineCount > 1 && (overLineBudget || overByteBudget)) {
        queuedBytes -= entry.bytes
        lineCount -= 1
        continue
      }
      retained.push(entry.line)
      retainedBytes += entry.bytes
    }
    pending.lines = retained
    pending.queuedBytes = retainedBytes
  }

  private measureLinesBytes(lines: DaemonBackpressuredStreamLine[]): number {
    let bytes = 0
    for (const line of lines) {
      bytes += this.measureLineBytes(line)
    }
    return bytes
  }

  private measureLineBytes(line: DaemonBackpressuredStreamLine): number {
    return Buffer.byteLength(line.line, 'utf8')
  }
}
