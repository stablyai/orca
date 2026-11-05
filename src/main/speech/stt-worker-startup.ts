import type { Worker } from 'node:worker_threads'
import type { SttEvent } from './stt-service'

export function waitForSttWorkerReady(worker: Worker, timeoutMs: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let settled = false
  let startupTimeout: ReturnType<typeof setTimeout> | null = null
  const cleanup = (): void => {
    if (startupTimeout) {
      clearTimeout(startupTimeout)
      startupTimeout = null
    }
    worker.off('message', onReadyOrError)
    worker.off('error', onStartupError)
    worker.off('exit', onStartupExit)
  }
  const failStartup = (error: Error): void => {
    if (settled) {
      return
    }
    settled = true
    cleanup()
    reject(error)
  }
  const onReadyOrError = (message: { type: string; error?: string }): void => {
    if (settled) {
      return
    }
    if (message.type === 'ready') {
      settled = true
      cleanup()
      resolve()
    } else if (message.type === 'error') {
      failStartup(new Error(message.error ?? 'Speech worker failed to initialize'))
    }
  }
  const onStartupError = (error: Error): void => failStartup(error)
  const onStartupExit = (code: number): void => {
    failStartup(new Error(`Speech worker exited before ready: ${code}`))
  }
  worker.on('message', onReadyOrError)
  worker.on('error', onStartupError)
  worker.on('exit', onStartupExit)
  startupTimeout = setTimeout(
    () => failStartup(new Error('Speech worker timed out while starting.')),
    timeoutMs
  )
  startupTimeout.unref?.()
  return promise
}

export function attachSttWorkerLifecycle(args: {
  worker: Worker
  isCurrent: () => boolean
  onMessage: (event: SttEvent) => void
  onError: (error: Error) => void
  onExit: () => void
}): () => void {
  const onWorkerMessage = (event: SttEvent): void => {
    if (args.isCurrent()) {
      args.onMessage(event)
    }
  }
  const onWorkerError = (error: Error): void => {
    if (args.isCurrent()) {
      args.onError(error)
    }
  }
  const onWorkerExit = (): void => {
    if (args.isCurrent()) {
      args.onExit()
    }
  }
  args.worker.on('message', onWorkerMessage)
  args.worker.on('error', onWorkerError)
  args.worker.on('exit', onWorkerExit)
  return () => {
    args.worker.off('message', onWorkerMessage)
    args.worker.off('error', onWorkerError)
    args.worker.off('exit', onWorkerExit)
  }
}

export function initializeSttWorker(
  worker: Worker,
  input: {
    modelDir: string
    modelType: string
    streaming: boolean
    sampleRate: number
    files: readonly string[]
    hotwordsFilePath?: string
    modelingUnit?: string
  }
): void {
  worker.postMessage({ type: 'init', ...input })
}
