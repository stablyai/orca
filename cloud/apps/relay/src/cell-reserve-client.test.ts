import { describe, expect, it, vi } from 'vitest'
import { CellReserveClient } from './cell-reserve-client.js'

const target = { cellId: 'c1', cellUrl: 'https://c1.example' }
const item = (userId: string, epoch = 3) => ({
  userId,
  relayHostId: 'abcdefghijklmnop',
  epoch,
  ttlMs: 30_000
})

describe('cell reserve client', () => {
  it('batches a cell’s bookings into one request and maps each answer back', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { items: Array<{ userId: string }> }
      return Response.json({
        v: 1,
        results: body.items.map((entry) =>
          entry.userId === 'b' ? { outcome: 'seated-newer', epoch: 9 } : { outcome: 'ok' }
        )
      })
    })
    const client = new CellReserveClient({
      directorId: 'director-a',
      identityToken: async () => 'token',
      fetch: fetchImpl
    })
    const answers = await Promise.all([
      client.reserve(target, item('a')),
      client.reserve(target, item('b')),
      client.reserve(target, item('c'), true)
    ])
    expect(answers).toEqual([{ outcome: 'ok' }, { outcome: 'seated-newer', epoch: 9 }, { outcome: 'ok' }])
    // One booking batch and one dry-run batch.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const first = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as Record<string, unknown>
    expect(first).toMatchObject({ v: 1, directorId: 'director-a', items: [{ userId: 'a' }, { userId: 'b' }] })
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://c1.example/internal/reserve')
  })

  it('reads every item as unreachable when the cell fails or answers out of shape', async () => {
    for (const fetchImpl of [
      async () => Promise.reject(new Error('timeout')),
      async () => new Response('nope', { status: 503 }),
      async () => Response.json({ v: 1, results: [] })
    ]) {
      const client = new CellReserveClient({
        directorId: 'director-a',
        identityToken: async () => 'token',
        fetch: fetchImpl
      })
      expect(await client.reserve(target, item('a'))).toEqual({ outcome: 'unreachable' })
    }
  })
})
