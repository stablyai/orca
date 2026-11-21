import { describe, expect, it, vi } from 'vitest'
import { ComposioApi, ComposioKeyRejectedError, ComposioLimitError } from './composio-api'

const answering = (status: number, body: unknown) =>
  new ComposioApi(
    'ak_test',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  )

describe('Composio answers', () => {
  it('refuses the key only on 401; a 403 is one endpoint the key may not use', async () => {
    await expect(answering(401, {}).app('x')).rejects.toBeInstanceOf(ComposioKeyRejectedError)
    const forbidden = answering(403, { error: { slug: 'Auth_ProjectAPIKeyNotAllowed' } })
    await expect(forbidden.app('x')).rejects.not.toBeInstanceOf(ComposioKeyRejectedError)
  })

  it('tells a burst from the plan’s cap by the answer’s words', async () => {
    const monthly = answering(429, { error: { message: 'Monthly usage limit reached' } })
    await expect(monthly.app('x')).rejects.toMatchObject({ retryAt: null })
    const burst = answering(429, { error: { message: 'Too many requests' } })
    await expect(burst.app('x')).rejects.toMatchObject({ retryAt: expect.any(Number) })
    const payment = answering(402, {})
    await expect(payment.app('x')).rejects.toBeInstanceOf(ComposioLimitError)
  })
})
