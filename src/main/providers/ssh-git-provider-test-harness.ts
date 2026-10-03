import { vi } from 'vitest'
import type { SshMultiplexerRequestOptions } from '../ssh/ssh-channel-multiplexer'

export type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  _response: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  onNotificationByMethod: ReturnType<typeof vi.fn>
  onDispose: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
}

export function createMockMux(): MockMultiplexer {
  const response = vi.fn().mockResolvedValue(undefined)
  return {
    _response: response,
    // Why: tests stub _response, and this wrapper runs beforeResolve during
    // response dispatch just like the real mux — requestGitStreamable rejects
    // when the hook never runs.
    request: vi.fn(
      async (
        method: string,
        params?: Record<string, unknown>,
        options?: SshMultiplexerRequestOptions
      ) => {
        const result: unknown = await response(method, params, options)
        options?.beforeResolve?.(result)
        return result
      }
    ),
    notify: vi.fn(),
    onNotification: vi.fn(),
    onNotificationByMethod: vi.fn().mockReturnValue(vi.fn()),
    // Why: requestGitStreamable subscribes to onDispose before awaiting the
    // response so it can reject in-flight reassembly if the link drops.
    onDispose: vi.fn().mockReturnValue(vi.fn()),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
}

export async function waitForRequestCount(
  mock: ReturnType<typeof vi.fn>,
  count: number
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (mock.mock.calls.length >= count) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}
