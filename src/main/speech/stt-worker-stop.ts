import type { Worker } from 'node:worker_threads'
import type { SttEventSink } from './stt-service'

export type SttWorkerStopOutcome = 'stopped' | 'error' | 'exit' | 'timeout'

export function waitForSttWorkerStop(args: {
  worker: Worker
  capturedSink: SttEventSink | null
  timeoutMs: number
  finish: (outcome: SttWorkerStopOutcome) => void
}): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    let receivedStopped = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      args.worker.off('message', onStopped)
      args.worker.off('error', onError)
      args.worker.off('exit', onExit)
    }
    const finish = (outcome: SttWorkerStopOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (outcome !== 'stopped' && !receivedStopped) {
        args.capturedSink?.({ type: 'stopped' })
      }
      args.finish(outcome)
      resolve()
    }
    const onStopped = (message: { type: string }): void => {
      if (message.type === 'stopped') {
        receivedStopped = true
        finish('stopped')
      }
    }
    const onError = (): void => finish('error')
    const onExit = (): void => finish('exit')

    timeout = setTimeout(() => finish('timeout'), args.timeoutMs)
    timeout.unref?.()
    args.worker.on('message', onStopped)
    args.worker.on('error', onError)
    args.worker.on('exit', onExit)
  })
}
