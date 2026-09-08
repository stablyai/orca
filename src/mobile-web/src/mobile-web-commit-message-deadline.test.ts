import { afterEach, expect, it, vi } from 'vitest'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'

afterEach(() => vi.useRealTimers())

it('allows slow commit generation and still cancels at its deadline', async () => {
  vi.useFakeTimers()
  const postMessage = vi.fn(() => true)
  const client = new MobileWebBridgeClient({
    context: { shellSessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) },
    grants: [
      {
        capability: 'sourceControl',
        operation: 'generateCommitMessage',
        limits: {
          maxRequestBytes: 4096,
          maxResponseBytes: 16384,
          maxConcurrent: 1,
          rateCapacity: 4,
          rateRefillPerSecond: 0.25
        }
      }
    ],
    postMessage
  })
  const result = client.sourceControlGenerateCommitMessage({
    workspaceId: 'workspace',
    expectedHead: 'a'.repeat(40)
  })
  const settled = vi.fn()
  void result.then(settled, settled)
  try {
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(result).rejects.toMatchObject({ code: 'timeout' })
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'cancel', target: 'request' })
    )
  } finally {
    client.dispose()
  }
})
