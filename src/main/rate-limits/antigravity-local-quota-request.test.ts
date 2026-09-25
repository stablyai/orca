import http from 'node:http'
import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { requestAntigravityLocalQuota } from './antigravity-local-quota-request'

async function withServer(
  handler: http.RequestListener,
  check: (port: number) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    if (!address || typeof address === 'string') {
      throw new Error('Expected a local TCP listener')
    }
    await check(address.port)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const options = { path: '/quota', csrfToken: 'synthetic-test-token', isHttps: false }

describe('local quota HTTP request', () => {
  it('releases the abort listener after successful requests', async () => {
    const controller = new AbortController()
    await withServer(
      (_request, response) => response.end('{"ok":true}'),
      async (port) => {
        for (let i = 0; i < 3; i++) {
          expect(
            await requestAntigravityLocalQuota({ ...options, port, signal: controller.signal })
          ).toEqual({ status: 200, body: { ok: true } })
        }
        await expect.poll(() => getEventListeners(controller.signal, 'abort').length).toBe(0)
      }
    )
  })

  it('aborts an in-flight response', async () => {
    const controller = new AbortController()
    await withServer(
      () => controller.abort(),
      async (port) => {
        await expect(
          requestAntigravityLocalQuota({ ...options, port, signal: controller.signal })
        ).rejects.toThrow()
      }
    )
  })

  it('rejects oversized responses', async () => {
    await withServer(
      (_request, response) => response.end('x'.repeat(1024 * 1024 + 1)),
      async (port) => {
        await expect(requestAntigravityLocalQuota({ ...options, port })).rejects.toThrow(
          'Quota response too large'
        )
      }
    )
  })
})
