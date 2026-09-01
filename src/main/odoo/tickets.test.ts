import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OdooInstance } from '../../shared/odoo-types'

const mocks = vi.hoisted(() => ({ executeKw: vi.fn(), getClients: vi.fn() }))

vi.mock('./client', () => ({
  acquire: async () => {},
  release: () => {},
  executeKw: mocks.executeKw,
  getClients: mocks.getClients
}))

const { listTickets, searchTickets } = await import('./tickets')

function instance(id: string): OdooInstance {
  return {
    id,
    serverUrl: `https://${id}.odoo.com`,
    database: id,
    login: 'admin',
    uid: 2,
    displayName: id
  }
}

/** One row shaped so `loadLookups` needs no extra round trip. */
function row(id: number, priority: string, writeDate: string): Record<string, unknown> {
  return { id, name: `Task ${id}`, priority, write_date: writeDate, create_date: writeDate }
}

describe('cross-instance ticket reads', () => {
  beforeEach(() => {
    mocks.executeKw.mockReset()
    mocks.getClients.mockReset()
  })

  it('cuts the flattened fan-out back to the requested limit', async () => {
    // The read runs once per instance with the same limit, so without the merge
    // a 2-instance fan-out returns `limit x 2` tickets.
    mocks.getClients.mockReturnValue([
      { instance: instance('alpha'), apiKey: 'k' },
      { instance: instance('beta'), apiKey: 'k' }
    ])
    mocks.executeKw
      .mockResolvedValueOnce([
        row(1, '1', '2026-08-10 10:00:00'),
        row(2, '0', '2026-08-09 10:00:00')
      ])
      .mockResolvedValueOnce([
        row(3, '3', '2026-08-01 10:00:00'),
        row(4, '0', '2026-08-14 10:00:00')
      ])

    const tickets = await listTickets('all', 2)

    expect(tickets).toHaveLength(2)
    // Odoo's own order (priority desc, then write_date desc) re-applied globally.
    expect(tickets.map((ticket) => ticket.id)).toEqual([3, 1])
  })

  it('leaves a result already within the limit untouched', async () => {
    mocks.getClients.mockReturnValue([{ instance: instance('alpha'), apiKey: 'k' }])
    mocks.executeKw.mockResolvedValueOnce([
      row(1, '0', '2026-08-10 10:00:00'),
      row(2, '3', '2026-08-09 10:00:00')
    ])

    const tickets = await searchTickets([], 30)

    expect(tickets.map((ticket) => ticket.id)).toEqual([1, 2])
  })
})
