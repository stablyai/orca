import { EventEmitter } from 'node:events'
import type { MessagePortMain } from 'electron'
import type { WorkerRequestTransport } from '../worker-threads/worker-thread-transport'
import type { SttRecognizerInit } from './stt-recognizer'

/** Electron reports it as the utility process's name when it exits. */
export const STT_UTILITY_PROCESS_NAME = 'Orca Speech'

export const STT_WORKER_EXITED_ERROR = 'The speech engine stopped unexpectedly. Try again.'
export const STT_WORKER_HUNG_ERROR = 'The speech engine stopped responding. Try again.'

export type SttWorkerRequest =
  | ({ type: 'init' } & SttRecognizerInit)
  | { type: 'open'; streamId: string; vocabulary: string[] }
  | { type: 'feed'; streamId: string; samples: Float32Array; sampleRate: number }
  | { type: 'stop'; streamId: string }
  | { type: 'discard'; streamId: string }
  | { type: 'attach-audio'; streamId: string }

export type SttWorkerProcess = Omit<WorkerRequestTransport, 'unref'> & {
  /** False when the process can't take a port (orcad's forked child), so audio stays on IPC. */
  attachAudioPort(streamId: string, port: MessagePortMain): boolean
}
export type SpawnSttWorkerProcess = () => SttWorkerProcess

/** Session code drops its listeners with removeAllListeners; this keeps the child's own intact. */
export class SttWorkerChildProcess extends EventEmitter implements SttWorkerProcess {
  private exited = false
  private readonly exit = Promise.withResolvers<number>()

  constructor(
    private readonly child: {
      send(message: SttWorkerRequest): void
      kill(): void
      sendPort?(message: SttWorkerRequest, port: MessagePortMain): void
    }
  ) {
    super()
  }

  postMessage(message: SttWorkerRequest): void {
    if (!this.exited) {
      this.child.send(message)
    }
  }

  attachAudioPort(streamId: string, port: MessagePortMain): boolean {
    if (this.exited || !this.child.sendPort) {
      return false
    }
    this.child.sendPort({ type: 'attach-audio', streamId }, port)
    return true
  }

  /** Kills even a decode stuck in native code; resolves once the process is gone. */
  terminate(): Promise<number> {
    if (!this.exited) {
      this.child.kill()
    }
    return this.exit.promise
  }

  receiveMessage(message: unknown): void {
    this.emit('message', message)
  }

  receiveExit(code: number | null): void {
    if (this.exited) {
      return
    }
    this.exited = true
    this.emit('exit', code ?? 1)
    this.exit.resolve(code ?? 1)
  }
}

/** Env for a speech child: CPU-only skips GPU backend registration, which can itself crash a driver. */
export function sttWorkerEnv(options: { cpuOnly: boolean }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(options.cpuOnly ? { TRANSCRIBE_BACKENDS: 'cpu' } : {}),
    // Implicit Vulkan layers (overlays, capture tools) crash some drivers' compute (Handy #2049).
    ...(process.platform === 'win32' ? { VK_LOADER_LAYERS_DISABLE: '~implicit~' } : {})
  }
}

export function logSttWorkerStderr(stderr: NodeJS.ReadableStream | null | undefined): void {
  stderr?.on('data', (chunk: Buffer) => {
    console.error('[speech-worker]', String(chunk).trimEnd())
  })
}
