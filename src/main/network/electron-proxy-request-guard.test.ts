import { describe, expect, it, vi } from 'vitest'

const { getProxySessionApplicationReadinessMock } = vi.hoisted(() => ({
  getProxySessionApplicationReadinessMock: vi.fn()
}))

vi.mock('./proxy-settings', () => ({
  getProxySessionApplicationReadiness: getProxySessionApplicationReadinessMock
}))

const { installElectronProxyRequestGuard } = await import('./electron-proxy-request-guard')

type CapturedRequest = (
  details: unknown,
  callback: (response: { cancel?: true } | Record<string, never>) => void
) => void

function capturedGuard(): CapturedRequest {
  let handler: CapturedRequest | null = null
  installElectronProxyRequestGuard({
    webRequest: {
      onBeforeRequest(captured: CapturedRequest) {
        handler = captured
      }
    }
  } as never)
  // SAFETY: installElectronProxyRequestGuard registers synchronously, so the handler is set here.
  return handler as unknown as CapturedRequest
}

function answerFor(readiness: unknown): Promise<{ cancel?: true } | Record<string, never>> {
  getProxySessionApplicationReadinessMock.mockReturnValue(readiness)
  return new Promise((resolve) => {
    capturedGuard()(null, (response) => resolve(response))
  })
}

describe('installElectronProxyRequestGuard readiness settlement', () => {
  it('answers synchronously for a boolean readiness', async () => {
    await expect(answerFor(true)).resolves.toEqual({})
    await expect(answerFor(false)).resolves.toEqual({ cancel: true })
  })

  it('answers when a promised readiness resolves', async () => {
    await expect(answerFor(Promise.resolve(true))).resolves.toEqual({})
    await expect(answerFor(Promise.resolve(false))).resolves.toEqual({ cancel: true })
  })

  it('fails closed and answers cancel when the readiness promise rejects (#43913)', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await expect(answerFor(Promise.reject(new Error('proxy transition failed')))).resolves.toEqual(
        { cancel: true }
      )
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
