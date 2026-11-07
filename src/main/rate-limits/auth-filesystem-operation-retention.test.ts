import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

function pendingOperation(): {
  operation: SharedAuthFilesystemOperation<string>
  resolve: (value: string) => void
  reject: (reason: unknown) => void
  rawCalls: () => number
} {
  let resolve = (_value: string): void => {}
  let reject = (_reason: unknown): void => {}
  let calls = 0
  const operation = createAuthFilesystemOperation('auth-retention-fixture', () => {
    calls += 1
    return new Promise<string>((resolveRaw, rejectRaw) => {
      resolve = resolveRaw
      reject = rejectRaw
    })
  })
  return {
    operation,
    resolve: (value) => resolve(value),
    reject: (reason) => reject(reason),
    rawCalls: () => calls
  }
}

async function abortWait(
  operation: SharedAuthFilesystemOperation<string>
): Promise<WeakRef<Error>> {
  const controller = new AbortController()
  const reason = new Error('Auth poll expired')
  const weakReason = new WeakRef(reason)
  const result = operation.wait(controller.signal)
  controller.abort(reason)
  await result.catch((error: unknown) => {
    if (error !== reason) {
      throw new Error('Abort reason identity changed')
    }
  })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  return weakReason
}

describe('shared auth filesystem wait lifetime', () => {
  it('preserves a live sibling and forwards raw failure identity to later waits', async () => {
    const pending = pendingOperation()
    const controller = new AbortController()
    const live = pending.operation.wait(controller.signal)
    await Promise.resolve()
    await abortWait(pending.operation)
    const reason = new Error('Raw filesystem failure')
    const rejected = expect(live).rejects.toBe(reason)
    pending.reject(reason)
    await rejected
    await expect(pending.operation.wait(controller.signal)).rejects.toBe(reason)
    expect(pending.rawCalls()).toBe(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})
