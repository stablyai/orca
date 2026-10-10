import type { Worker } from 'node:worker_threads'

// Match the startup audio byte allowance; tiny frames also need a count bound.
export const MAX_PENDING_STT_AUDIO_BYTES = 8 * 1024 * 1024
export const MAX_PENDING_STT_AUDIO_FRAMES = 1024
export const STT_AUDIO_OVERLOAD_ERROR =
  'Speech recognition cannot keep up with microphone audio. Dictation stopped; please try again.'

type WorkerQueue = {
  postedBytes: number
  consumedBytes: number
  postedFrames: number
  consumedFrames: number
  onMessage: (message: { type?: string; byteEnd?: number; frameEnd?: number }) => void
  onExit: () => void
}

export class SttAudioPendingBudget {
  private pendingBytes = 0
  private pendingFrames = 0
  private readonly owners = new Map<Worker, WorkerQueue>()

  tryPost(worker: Worker, samples: Float32Array, sampleRate: number): boolean {
    if (samples.length === 0) {
      return true
    }
    const backing = samples.buffer
    const bytes = backing.byteLength
    if (
      this.pendingBytes + bytes > MAX_PENDING_STT_AUDIO_BYTES ||
      this.pendingFrames >= MAX_PENDING_STT_AUDIO_FRAMES
    ) {
      return false
    }
    const queue = this.owners.get(worker) ?? this.observe(worker)
    queue.postedBytes += bytes
    queue.postedFrames += 1
    this.pendingFrames += 1
    this.pendingBytes += bytes
    try {
      worker.postMessage(
        {
          type: 'feed',
          samples,
          sampleRate,
          byteEnd: queue.postedBytes,
          frameEnd: queue.postedFrames
        },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Native postMessage validates transferability, as in the existing feed path.
        [backing as ArrayBuffer]
      )
    } catch (error) {
      if (backing.byteLength === bytes) {
        queue.postedBytes -= bytes
        queue.postedFrames -= 1
        this.pendingFrames -= 1
        this.pendingBytes -= bytes
      }
      throw error
    }
    return true
  }

  terminateWorker(worker: Worker): Promise<number> {
    const queue = this.owners.get(worker)
    // Lifecycle cleanup removes listeners before requesting termination.
    if (queue) {
      this.attach(worker, queue)
    }
    return worker.terminate().then((code) => {
      this.forget(worker)
      return code
    })
  }

  private observe(worker: Worker): WorkerQueue {
    // Cumulative acknowledgments avoid retaining a callback or record per frame.
    const queue: WorkerQueue = {
      postedBytes: 0,
      consumedBytes: 0,
      postedFrames: 0,
      consumedFrames: 0,
      onMessage: (message) => {
        const end = message.byteEnd
        const frameEnd = message.frameEnd
        if (
          message.type !== 'audio-consumed' ||
          typeof end !== 'number' ||
          !Number.isSafeInteger(end) ||
          typeof frameEnd !== 'number' ||
          !Number.isSafeInteger(frameEnd) ||
          frameEnd <= queue.consumedFrames ||
          frameEnd > queue.postedFrames ||
          end <= queue.consumedBytes ||
          end > queue.postedBytes ||
          this.owners.get(worker) !== queue
        ) {
          return
        }
        this.pendingBytes -= end - queue.consumedBytes
        queue.consumedBytes = end
        this.pendingFrames -= frameEnd - queue.consumedFrames
        queue.consumedFrames = frameEnd
      },
      onExit: () => this.forget(worker)
    }
    this.owners.set(worker, queue)
    this.attach(worker, queue)
    return queue
  }

  private attach(worker: Worker, queue: WorkerQueue): void {
    worker.off('message', queue.onMessage)
    worker.off('exit', queue.onExit)
    worker.on('message', queue.onMessage)
    worker.on('exit', queue.onExit)
  }

  private forget(worker: Worker): void {
    const queue = this.owners.get(worker)
    if (!queue) {
      return
    }
    this.pendingBytes -= queue.postedBytes - queue.consumedBytes
    this.pendingFrames -= queue.postedFrames - queue.consumedFrames
    this.owners.delete(worker)
    worker.off('message', queue.onMessage)
    worker.off('exit', queue.onExit)
  }
}
