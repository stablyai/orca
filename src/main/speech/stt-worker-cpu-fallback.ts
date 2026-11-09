import { EventEmitter } from 'node:events'
import type { MessagePortMain } from 'electron'
import { OFFLINE_DECODE_CHUNK_SECONDS } from './stt-offline-audio-chunker'
import type { SttWorkerProcess, SttWorkerRequest } from './stt-worker-process'

export type SpawnSttChild = (options: { cpuOnly: boolean }) => SttWorkerProcess

export type SttGpuPolicy = {
  /** False when the user turned the GPU off or this machine's GPU already failed. */
  allowGpu(): boolean
  markGpuFailed(): void
}

type Feed = Extract<SttWorkerRequest, { type: 'feed' }>
type Open = Extract<SttWorkerRequest, { type: 'open' }>
type ChildMessage =
  | { type: 'chunk'; streamId: string; text: string; samples: number }
  | {
      type: 'ready' | 'stopped' | 'error' | 'partial' | 'final'
      streamId?: string
      text?: string
      error?: string
    }

/** A dictation's audio the GPU has not decoded yet, kept for a CPU replay. */
type StreamBacklog = {
  open: Open | null
  feeds: Feed[]
  /** Input samples before feeds[0], in the stream's own count. */
  start: number
  seconds: number
  pending: 'stop' | 'discard' | null
}

// Well under the session's 60 s start and stop timeouts, so a CPU replay still fits; covers first-run shader compiles.
const GPU_STALL_TIMEOUT_MS = 25_000

/**
 * Runs transcribe-cpp on the GPU and, when the GPU fails to load, errors, stalls or crashes the
 * process, moves every dictation to a CPU-only process and replays the audio not yet decoded.
 * Session code sees one worker throughout.
 */
class SttCpuFallbackWorker extends EventEmitter implements SttWorkerProcess {
  private child!: SttWorkerProcess
  private detachChild: () => void = () => undefined
  private cpuOnly: boolean
  private init: Extract<SttWorkerRequest, { type: 'init' }> | null = null
  private ready = false
  private exitRequested = false
  private markOnCpuReady = false
  private readonly streams = new Map<string, StreamBacklog>()
  private stallTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly spawn: SpawnSttChild,
    private readonly gpu: SttGpuPolicy
  ) {
    super()
    this.cpuOnly = !gpu.allowGpu()
    this.attach(spawn({ cpuOnly: this.cpuOnly }))
  }

  postMessage(msg: SttWorkerRequest): void {
    if (msg.type === 'init') {
      this.init = msg
    } else if (msg.type === 'open' && this.canFallBack()) {
      this.backlog(msg.streamId).open = msg
    } else if (msg.type === 'feed' && this.canFallBack()) {
      const stream = this.backlog(msg.streamId)
      stream.feeds.push(msg)
      stream.seconds += msg.samples.length / msg.sampleRate
    } else if ((msg.type === 'stop' || msg.type === 'discard') && this.canFallBack()) {
      this.backlog(msg.streamId).pending = msg.type
    }
    this.watchForStall(false)
    this.child.postMessage(msg)
  }

  /** A GPU process keeps audio on IPC, where this wrapper can hold it for a CPU replay. */
  attachAudioPort(streamId: string, port: MessagePortMain): boolean {
    return !this.canFallBack() && this.child.attachAudioPort(streamId, port)
  }

  terminate(): Promise<number> {
    this.exitRequested = true
    this.clearStallTimer()
    return this.child.terminate()
  }

  private canFallBack(): boolean {
    return this.init !== null && !this.cpuOnly && !this.exitRequested
  }

  private backlog(streamId: string): StreamBacklog {
    let stream = this.streams.get(streamId)
    if (!stream) {
      stream = { open: null, feeds: [], start: 0, seconds: 0, pending: null }
      this.streams.set(streamId, stream)
    }
    return stream
  }

  private attach(child: SttWorkerProcess): void {
    const onMessage = (message: ChildMessage): void => this.receive(message)
    const onExit = (code: number): void => {
      // An idle process killed from outside (OOM, Activity Monitor) is not a GPU failure.
      if (this.canFallBack() && (!this.ready || this.streams.size > 0)) {
        this.fallBack(true)
      } else {
        this.emit('exit', code)
      }
    }
    child.on('message', onMessage)
    child.on('exit', onExit)
    this.child = child
    this.detachChild = () => {
      child.off('message', onMessage)
      child.off('exit', onExit)
    }
  }

  private receive(message: ChildMessage): void {
    if (message.type === 'error' && this.canFallBack()) {
      this.fallBack(!this.ready)
      return
    }
    if (message.type === 'error' && !message.streamId && this.ready) {
      // The CPU replacement could not load: fail every dictation now rather than answer them empty.
      this.detachChild()
      void this.child.terminate().catch(() => undefined)
      this.emit('exit', 1)
      return
    }
    if (message.type === 'chunk') {
      const { streamId, text, samples } = message
      const stream = this.streams.get(streamId)
      if (stream) {
        this.trimBacklog(stream, samples)
      }
      this.watchForStall(true)
      if (text) {
        this.emit('message', { type: 'final', streamId, text })
      }
      return
    }
    if (message.type === 'ready') {
      if (this.markOnCpuReady) {
        this.markOnCpuReady = false
        this.gpu.markGpuFailed()
      }
      if (this.ready) {
        return
      }
      this.ready = true
      this.watchForStall(true)
    } else if (message.type === 'stopped' && message.streamId) {
      this.streams.delete(message.streamId)
      this.watchForStall(true)
    }
    this.emit('message', message)
  }

  /** `persist`: the GPU itself failed (crash or load error), not just this audio. */
  private fallBack(persist: boolean): void {
    this.clearStallTimer()
    this.detachChild()
    void this.child.terminate().catch(() => undefined)
    // Persist only once CPU loads the model: a broken model must not turn the GPU off.
    this.markOnCpuReady = persist
    this.cpuOnly = true
    this.attach(this.spawn({ cpuOnly: true }))
    if (this.init) {
      this.child.postMessage(this.init)
    }
    for (const [streamId, stream] of this.streams) {
      // A canceled dictation wants no text, so its audio is not replayed.
      if (stream.pending !== 'discard') {
        if (stream.open) {
          this.child.postMessage(stream.open)
        }
        for (const feed of stream.feeds) {
          this.child.postMessage(feed)
        }
      }
      if (stream.pending) {
        this.child.postMessage({ type: stream.pending, streamId })
      }
    }
    this.streams.clear()
  }

  private trimBacklog(stream: StreamBacklog, decodedSamples: number): void {
    while (stream.feeds.length > 0) {
      const first = stream.feeds[0]
      const end = stream.start + first.samples.length
      const dropped = Math.min(first.samples.length, decodedSamples - stream.start)
      stream.seconds -= dropped / first.sampleRate
      if (end > decodedSamples) {
        stream.feeds[0] = { ...first, samples: first.samples.subarray(dropped) }
        stream.start = decodedSamples
        return
      }
      stream.feeds.shift()
      stream.start = end
    }
  }

  /** The GPU owes progress while loading, finishing a stop, or once a full chunk waits undecoded. */
  private owesProgress(): boolean {
    if (!this.ready) {
      return this.init !== null
    }
    for (const stream of this.streams.values()) {
      if (stream.pending === 'stop' || stream.seconds > OFFLINE_DECODE_CHUNK_SECONDS) {
        return true
      }
    }
    return false
  }

  /** `progressed`: the GPU just answered, so a running timer restarts. */
  private watchForStall(progressed: boolean): void {
    if (progressed || !this.canFallBack() || !this.owesProgress()) {
      this.clearStallTimer()
    }
    if (this.stallTimer || !this.canFallBack() || !this.owesProgress()) {
      return
    }
    // Not persisted: a first-run shader compile or cold model read can be slow once and fine after.
    this.stallTimer = setTimeout(() => this.fallBack(false), GPU_STALL_TIMEOUT_MS)
    this.stallTimer.unref?.()
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
  }
}

export function spawnSttWorkerWithCpuFallback(
  spawn: SpawnSttChild,
  gpu: SttGpuPolicy
): SttWorkerProcess {
  return new SttCpuFallbackWorker(spawn, gpu)
}
