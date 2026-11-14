import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock, handlers } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel))
  },
  net: { fetch: (...args: unknown[]) => fetchMock(...args) }
}))
import { registerFeedbackHandlers, submitFeedback } from './feedback'

function okResponse(): Response {
  return { ok: true, status: 200 } as unknown as Response
}

function requestInit(callIndex = 0): RequestInit {
  return fetchMock.mock.calls[callIndex]?.[1] as RequestInit
}

describe('submitFeedback', () => {
  beforeEach(() => {
    vi.useRealTimers()
    handlers.clear()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(okResponse())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('image attachments', () => {
    function pngImage(bytes = 8): { contentType: string; data: Uint8Array } {
      return { contentType: 'image/png', data: new Uint8Array(bytes).fill(1) }
    }

    function imageSubmitArgs(
      images: { contentType: string; data: Uint8Array }[]
    ): Parameters<typeof submitFeedback>[0] {
      return {
        feedback: 'images attached',
        submissionType: 'feedback',
        githubLogin: 'someone',
        githubEmail: null,
        images
      }
    }

    it('reports unconfirmed delivery for a settled non-JSON 2xx', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 202,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        }
      } as unknown as Response)

      await expect(submitFeedback(imageSubmitArgs([pngImage()]))).resolves.toEqual({
        ok: true,
        imagesDelivered: false
      })
    })

    it('fails a stalled delivery response body at the attachment timeout', async () => {
      vi.useFakeTimers()
      fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 202,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('body aborted')))
            })
        } as unknown as Response)
      )

      const result = submitFeedback(imageSubmitArgs([pngImage()]))
      await vi.advanceTimersByTimeAsync(60_000)

      await expect(result).resolves.toEqual({
        ok: false,
        status: null,
        error: 'request timed out after 60 seconds'
      })
      expect(requestInit().signal).toMatchObject({ aborted: true })
    })

    // Enforce MIME ownership at IPC even if a renderer bypasses its own checks.
    it('rejects a prototype member posing as a content type over IPC', async () => {
      registerFeedbackHandlers()
      const result = (await handlers.get('feedback:submit')?.(null, {
        feedback: 'images attached',
        githubLogin: null,
        githubEmail: null,
        images: [{ contentType: 'constructor', data: new Uint8Array(4).fill(1) }]
      })) as { ok: boolean; error?: string }

      expect(result).toMatchObject({ ok: false, error: 'Unsupported image type.' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('rejects malformed IPC bytes before typed-array normalization', async () => {
      registerFeedbackHandlers()
      const result = (await handlers.get('feedback:submit')?.(null, {
        feedback: 'images attached',
        githubLogin: null,
        githubEmail: null,
        images: [{ contentType: 'image/png', data: '8388608' }]
      })) as { ok: boolean; error?: string }

      expect(result).toMatchObject({ ok: false, error: 'Invalid image attachment bytes.' })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
