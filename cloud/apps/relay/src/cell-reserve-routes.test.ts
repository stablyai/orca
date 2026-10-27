import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { registerCellReserveRoutes } from './cell-reserve-routes.js'
import type { RelayConfig } from './config.js'

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
  return { post, reserve, demote }
}

const booking = {
  v: 1,
  directorId: 'director-a',
  items: [{ userId: 'user-1', relayHostId: 'abcdefghijklmnop', epoch: 3, ttlMs: 30_000 }]
}

describe('cell reserve routes', () => {
  it('books for a director holding the rehome credential and refuses everyone else', async () => {
    const { post, reserve } = app()
    const ok = await post('/internal/reserve', booking)
    expect(await ok.json()).toEqual({ v: 1, results: [{ outcome: 'ok' }] })
    expect((await post('/internal/reserve', booking, 'someone-else')).status).toBe(401)
    expect((await post('/internal/reserve', { ...booking, items: [] })).status).toBe(400)
    expect((await post('/internal/reserve', { ...booking, v: 2 })).status).toBe(400)
    expect(reserve).toHaveBeenCalledTimes(1)
  })

  it('is absent on a director and on a cell without the rehome pair', async () => {
    expect((await app({ ...cell, role: 'director' }).post('/internal/reserve', booking)).status).toBe(404)
    const noPair = app({ ...cell, rehomeDirectorServiceAccount: undefined })
    expect((await noPair.post('/internal/demote', {})).status).toBe(404)
  })

  it('demotes only a fully named seat', async () => {
    const { post, demote } = app()
    const seat = { v: 1, userId: 'user-1', relayHostId: 'abcdefghijklmnop', epoch: 3 }
    expect((await post('/internal/demote', seat)).status).toBe(400)
    const reply = await post('/internal/demote', { ...seat, joinedAt: 1_000 })
    expect(await reply.json()).toEqual({ v: 1, outcome: 'demoted' })
    expect(demote).toHaveBeenCalledWith({ ...seat, joinedAt: 1_000 })
  })
})
