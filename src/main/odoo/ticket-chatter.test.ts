import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OdooInstance } from '../../shared/odoo-types'

const mocks = vi.hoisted(() => ({ executeKw: vi.fn(), getClients: vi.fn() }))

vi.mock('./client', () => ({
  acquire: async () => {},
  release: () => {},
  executeKw: mocks.executeKw,
  getClients: mocks.getClients
}))

const { getTicketComments, ODOO_TICKET_COMMENT_PAGE_SIZE } = await import('./ticket-chatter')

const instance: OdooInstance = {
  id: 'alpha',
  serverUrl: 'https://alpha.odoo.com',
  database: 'alpha',
  login: 'admin',
  uid: 2,
  displayName: 'alpha'
}

describe('getTicketComments', () => {
  beforeEach(() => {
    mocks.executeKw.mockReset()
    mocks.getClients.mockReset()
    mocks.getClients.mockReturnValue([{ instance, apiKey: 'k' }])
  })

  it('reads a bounded newest-first page and returns it oldest-first', async () => {
    // Newest-first + limit keeps a long-lived ticket from shipping every body
    // and author avatar on each refresh; the panel still renders ascending.
    const messages = [
      { id: 3, body: '<p>third</p>', date: '2026-08-14 12:00:00' },
      { id: 2, body: '<p>second</p>', date: '2026-08-13 12:00:00' },
      { id: 1, body: '<p>first</p>', date: '2026-08-12 12:00:00' }
    ]
    mocks.executeKw.mockImplementation(
      async (_client: unknown, model: string, _method: string, _args: unknown[]) =>
        model === 'mail.message' ? messages : []
    )

    const comments = await getTicketComments(42)

    const searchCall = mocks.executeKw.mock.calls.find(([, model]) => model === 'mail.message')
    expect(searchCall?.[4]).toMatchObject({
      order: 'date desc',
      limit: ODOO_TICKET_COMMENT_PAGE_SIZE
    })
    expect(comments.map((comment) => comment.id)).toEqual([1, 2, 3])
    expect(comments.map((comment) => comment.body)).toEqual(['first', 'second', 'third'])
  })
})
