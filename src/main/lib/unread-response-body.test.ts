import { describe, expect, it, vi } from 'vitest'
import { cancelUnreadResponseBody } from './unread-response-body'

function responseWithCancelTracking(status = 500): {
  response: Response
  cancelled: () => boolean
} {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('unread error body'))
    },
    cancel() {
      cancelled = true
    }
  })
  return { response: new Response(body, { status }), cancelled: () => cancelled }
}

describe('cancelUnreadResponseBody', () => {
  it('cancels an unread body stream', async () => {
    const { response, cancelled } = responseWithCancelTracking()
    await cancelUnreadResponseBody(response)
    expect(cancelled()).toBe(true)
  })

  it('no-ops on a body-less response', async () => {
    await expect(
      cancelUnreadResponseBody(new Response(null, { status: 500 }))
    ).resolves.toBeUndefined()
  })

  it('swallows cancellation failures on a locked stream', async () => {
    const { response } = responseWithCancelTracking()
    response.body?.getReader()
    await expect(cancelUnreadResponseBody(response)).resolves.toBeUndefined()
  })

  it('swallows a rejecting cancel', async () => {
    const response = {
      body: { cancel: vi.fn().mockRejectedValue(new Error('already destroyed')) }
    } as unknown as Response
    await expect(cancelUnreadResponseBody(response)).resolves.toBeUndefined()
    expect(
      (response.body as unknown as { cancel: ReturnType<typeof vi.fn> }).cancel
    ).toHaveBeenCalled()
  })
})
