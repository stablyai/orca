import { describe, expect, it } from 'vitest'
import { cancelUnreadResponseBody } from './unread-response-body'
import { cancelTrackingResponse } from './unread-response-body.test-fixtures'

describe('cancelUnreadResponseBody', () => {
  it('cancels an unread body stream', async () => {
    let cancelled = false
    await cancelUnreadResponseBody(
      cancelTrackingResponse(500, () => {
        cancelled = true
      })
    )
    expect(cancelled).toBe(true)
  })

  it('no-ops on a body-less response', async () => {
    await expect(
      cancelUnreadResponseBody(new Response(null, { status: 500 }))
    ).resolves.toBeUndefined()
  })

  it('swallows cancellation failures on a locked stream', async () => {
    const response = cancelTrackingResponse(500, () => {})
    response.body?.getReader()
    await expect(cancelUnreadResponseBody(response)).resolves.toBeUndefined()
  })
})
