import type { Worker } from 'node:worker_threads'
import type { OpenCodeSqliteCaptureBatch } from './session-scanner-opencode-sqlite-worker-protocol'
import { AsyncResource } from 'node:async_hooks'
import {
  captureSessionSearchMessage,
  checkpointSessionSearchCapture,
  type SessionSearchCapturedMessage
} from './session-search-capture'

// The main-thread end of the worker's capture batch/ack loop: one batch in
// flight, acknowledged only once the caller's sink has taken it.

export type OpenCodeCaptureConsumer = (messages: SessionSearchCapturedMessage[]) => Promise<void>

/** Binds the current capture scope: AsyncLocalStorage does not survive the worker hop. */
export function bindOpenCodeCaptureConsumer(): OpenCodeCaptureConsumer {
  return AsyncResource.bind(async (messages: SessionSearchCapturedMessage[]) => {
    for (const message of messages) {
      captureSessionSearchMessage(message)
    }
    await checkpointSessionSearchCapture()
  })
}

type DeadlinedCall = {
  capture?: OpenCodeCaptureConsumer
  timer: NodeJS.Timeout | null
  timeoutMs: number
}

// Why: the consumer hands its rows to SessionSearchIndexWriter.apply, which
// serializes every file's write on one chain, and a list scan parses up to
// SESSION_PARSE_CONCURRENCY candidates at once. So this wait is mostly other
// files' queue time, not evidence about this worker, and charging it to the
// worker's own budget killed healthy parses. Still bounded, and still under the
// 130 s scan backstop, so a genuinely wedged writer ends as one scan issue.
export const CAPTURE_CONSUMER_TIMEOUT_MS = 60_000

// Reset rather than cleared: total production time stays unbounded (that is the
// point of the credit loop), but each individual stall is still capped, so a
// backlogged index writer costs one scan issue instead of wedging the client.
function restartDeadline(
  call: DeadlinedCall,
  timeoutMs: number,
  onTimeout: (timeoutMs: number) => void
): void {
  if (call.timer) {
    clearTimeout(call.timer)
  }
  call.timer = setTimeout(() => onTimeout(timeoutMs), timeoutMs)
  call.timer.unref?.()
}

export function receiveOpenCodeCaptureBatch(args: {
  call: DeadlinedCall
  batch: OpenCodeSqliteCaptureBatch
  worker: Worker | null
  isActive: () => boolean
  onTimeout: (timeoutMs: number) => void
  onProtocolViolation: (error: Error) => void
  onConsumerError: (error: Error) => void
}): void {
  const { call } = args
  if (!call.capture) {
    args.onProtocolViolation(new Error('Unexpected OpenCode capture batch.'))
    return
  }
  restartDeadline(call, CAPTURE_CONSUMER_TIMEOUT_MS, args.onTimeout)
  void call
    .capture(args.batch.messages)
    .then(() => {
      if (!args.isActive()) {
        return
      }
      // Back to the worker's own budget: the next event has to come from it.
      restartDeadline(call, call.timeoutMs, args.onTimeout)
      args.worker?.postMessage({
        id: args.batch.id,
        kind: 'captureAck',
        batch: args.batch.batch
      })
    })
    .catch((error) => {
      if (args.isActive()) {
        args.onConsumerError(error instanceof Error ? error : new Error(String(error)))
      }
    })
}
