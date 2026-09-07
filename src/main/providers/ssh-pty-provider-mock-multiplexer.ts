import { expect, vi } from 'vitest'

/** The relay channel SshPtyProvider talks to, stubbed for the provider's own tests. */
export type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
}

export function createMockMux(): MockMultiplexer {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
}

export const sourceActivationRequestOptions = expect.objectContaining({
  beforeResolve: expect.any(Function)
})

/** Asserts one request was made, ignoring arguments past the ones named. */
export function expectRequest(request: ReturnType<typeof vi.fn>, ...expected: unknown[]): void {
  expect(request.mock.calls.map((call) => call.slice(0, expected.length))).toContainEqual(expected)
}
