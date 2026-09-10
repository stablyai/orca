import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  uploadTicketAttachments: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../odoo/ticket-chatter', () => ({
  addTicketComment: vi.fn(),
  getTicketComments: vi.fn(),
  searchMentionCandidates: vi.fn(),
  updateTicketComment: vi.fn(),
  uploadTicketAttachments: mocks.uploadTicketAttachments
}))

const { registerOdooTicketChatterHandlers } = await import('./odoo-ticket-chatter')

type Handler = (event: unknown, args: unknown) => Promise<unknown>

function uploadHandler(): Handler {
  registerOdooTicketChatterHandlers()
  const entry = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'odoo:uploadTicketAttachments'
  )
  if (!entry) {
    throw new Error('odoo:uploadTicketAttachments was not registered')
  }
  return entry[1] as Handler
}

describe('odoo:uploadTicketAttachments', () => {
  beforeEach(() => {
    mocks.handle.mockReset()
    mocks.uploadTicketAttachments.mockReset()
    mocks.uploadTicketAttachments.mockResolvedValue({ ok: true, ids: [1] })
  })

  const valid = { name: 'spec.pdf', mimetype: 'application/pdf', data: 'AAA=' }

  it('uploads a well-formed batch', async () => {
    const result = await uploadHandler()(null, { ticketId: 7, files: [valid] })
    expect(result).toEqual({ ok: true, ids: [1] })
    expect(mocks.uploadTicketAttachments).toHaveBeenCalledWith(7, [valid], undefined)
  })

  it('fails the batch instead of silently dropping a malformed entry', async () => {
    // Filtering the bad entry out would report ok:true for a partial upload.
    const result = await uploadHandler()(null, {
      ticketId: 7,
      files: [valid, { name: 'x.png', mimetype: 'image/png' }]
    })
    expect(result).toEqual({ ok: false, error: 'One or more attachments are malformed.' })
    expect(mocks.uploadTicketAttachments).not.toHaveBeenCalled()
  })

  it('rejects a sparse files array', async () => {
    const files = [valid, valid]
    delete files[0]
    const result = await uploadHandler()(null, { ticketId: 7, files })
    expect(result).toEqual({ ok: false, error: 'One or more attachments are malformed.' })
    expect(mocks.uploadTicketAttachments).not.toHaveBeenCalled()
  })
})
