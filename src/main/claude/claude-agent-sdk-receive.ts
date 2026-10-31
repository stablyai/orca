import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { withTimeout } from '../../shared/promise-timeout-fallback'

/** A foreign empty reader must report a fault rather than hold process cleanup forever. */
export const CLAUDE_READER_DRAIN_AFTER_EXIT_MS = 2_000

export async function finishClaudeSdkReceive(input: {
  finishInput: () => Promise<void>
  receivedInput: () => boolean
  receiveCompleted: Promise<void> | undefined
  readerDone: Promise<void>
  externalContractRequired: boolean
  onFault?: (error: Error) => void
}): Promise<void> {
  const inputFailure = await input.finishInput().then(
    () => null,
    (error: unknown) => error
  )
  if (input.receiveCompleted && typeof input.receiveCompleted.then === 'function') {
    // Public delivery acknowledges receipt before SDK-only cleanup completes the pump.
    const received = await input.receiveCompleted.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error })
    )
    await input.readerDone
    if (!received.ok) {
      throw received.error
    }
  } else if (input.externalContractRequired) {
    throw new Error('Claude SDK external receive contract is unavailable')
  } else if (input.receivedInput()) {
    await input.readerDone
  } else {
    const drained = await withTimeout(
      input.readerDone.then(() => true),
      CLAUDE_READER_DRAIN_AFTER_EXIT_MS,
      false
    )
    if (!drained) {
      const error = new Error('Claude output reader did not complete after input EOF')
      input.onFault?.(error)
      throw error
    }
  }
  if (inputFailure !== null) {
    throw inputFailure
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Pressure delays the next request, never delivery of a value already resolved by the SDK. */
export async function readClaudeSdkMessages(input: {
  query: Pick<Query, 'next'>
  waitUntilReadable: () => Promise<void>
  onMessage: (message: Record<string, unknown>) => void
}): Promise<void> {
  for (;;) {
    await input.waitUntilReadable()
    const next = await input.query.next()
    if (next.done) {
      return
    }
    if (!isRecord(next.value)) {
      throw new Error('claude stream-json yielded a non-object message')
    }
    input.onMessage(next.value)
  }
}
