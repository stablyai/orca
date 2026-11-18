import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { registerCellReserveRoutes } from './cell-reserve-routes.js'
import type { RelayConfig } from '../../config.js'

const cell = {
  role: 'cell',
  cellId: 'production-gce-c3',
  rehomeAudience: 'https://relay.example/rehome',
  rehomeDirectorServiceAccount: 'director@example.com'
} as RelayConfig

function app(config: RelayConfig = cell) {
  const reserve = vi.fn(() => [{ outcome: 'ok' as const }])
  const demote = vi.fn(() => 'demoted')
  const routes = new Hono()
  registerCellReserveRoutes(routes, config, {
    verifyRegionalRehomeToken: async (token) => token === 'director-token',
    reserve,
    demote
  })
  const post = (path: string, body: unknown, token = 'director-token') =>
    routes.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  const postChunked = (path: string, body: string) =>
    routes.request(path, {
      method: 'POST',
      headers: { authorization: 'Bearer director-token', 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body))
          controller.close()
        }
      }),
      duplex: 'half'
    } as RequestInit)
  return { post, postChunked, reserve, demote, routes }
}

describe('cell reserve routes', () => {

  it.each(['/internal/reserve', '/internal/demote'])(
    'rejects an oversized chunked body on %s without calling the handler',
    async (path) => {
      const { postChunked, reserve, demote } = app()
      const response = await postChunked(path, ' '.repeat(16 * 1024 + 1))

      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ error: 'request_too_large' })
      expect(reserve).not.toHaveBeenCalled()
      expect(demote).not.toHaveBeenCalled()
    }
  )

  it.each(['/internal/reserve', '/internal/demote'])(
    'refuses %s without waiting for a chunked body',
    async (path) => {
      const { routes, reserve, demote } = app()
      const response = await Promise.race([
        routes.request(path, {
          method: 'POST',
          headers: { authorization: 'Bearer someone-else', 'content-type': 'application/json' },
          body: new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => {})
          }),
          duplex: 'half'
        } as RequestInit),
        new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new Error('waited for the body')), 200)
        })
      ])

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'invalid_token' })
      expect(reserve).not.toHaveBeenCalled()
      expect(demote).not.toHaveBeenCalled()
    }
  )

})
