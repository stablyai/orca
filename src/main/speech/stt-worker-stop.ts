import type { SttEventSink } from './stt-service'
import type { SttWorkerEvent } from './stt-worker-startup'
import {
  STT_WORKER_EXITED_ERROR,
  STT_WORKER_HUNG_ERROR,
  type SttWorkerProcess
} from './stt-worker-process'

export type SttWorkerStopOutcome = 'stopped' | 'error' | 'exit' | 'timeout'

export function waitForSttWorkerStop(args: {
  worker: SttWorkerProcess
  streamId: string
  sink: SttEventSink
  timeoutMs: number
  discard: boolean
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
    const finish = (outcome: SttWorkerStopOutcome, processError?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (outcome !== 'stopped' && !receivedStopped) {
        // A canceled dictation wants no text; a finishing one lost its tail and must say so.
        if (!args.discard) {
          args.sink({ type: 'error', error: stopErrorMessage(outcome, processError) })
        }
        args.sink({ type: 'stopped' })
      }
      args.finish(outcome)
      resolve()
    }
    const onStopped = (message: SttWorkerEvent): void => {
      if (message.type === 'stopped' && message.streamId === args.streamId) {
        receivedStopped = true
        finish('stopped')
      }
    }
    const onError = (error: Error): void => finish('error', error)
    const onExit = (): void => finish('exit')

    timeout = setTimeout(() => finish('timeout'), args.timeoutMs)
    timeout.unref?.()
    args.worker.on('message', onStopped)
    args.worker.on('error', onError)
    args.worker.on('exit', onExit)
  })
}

function stopErrorMessage(outcome: SttWorkerStopOutcome, processError: Error | undefined): string {
  if (outcome === 'timeout') {
    return STT_WORKER_HUNG_ERROR
  }
  return processError ? String(processError) : STT_WORKER_EXITED_ERROR
}
