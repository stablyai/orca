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
import { submitFeedback } from './feedback'

function okResponse(): Response {
  return { ok: true, status: 200 } as unknown as Response
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

    // Enforce MIME ownership at IPC even if a renderer bypasses its own checks.
  })
})
