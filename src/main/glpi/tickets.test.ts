import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlpiServer } from '../../shared/types'

vi.mock('./session', () => ({
  acquire: vi.fn(async () => {}),
  release: vi.fn(),
  glpiServerRequest: vi.fn(),
  GlpiApiError: class extends Error {},
  isAuthError: () => false
}))

// Imported after the mock declaration so the mocked implementation is in place.
import { glpiServerRequest } from './session'
import {
  addGlpiFollowup,
  createGlpiTicket,
  getGlpiTicket,
  listGlpiTickets,
  updateGlpiTicket
} from './tickets'

const request = vi.mocked(glpiServerRequest)

const server: GlpiServer = {
  id: 'srv-1',
  baseUrl: 'https://glpi.example.com',
  apiBaseUrl: 'https://glpi.example.com/apirest.php',
  displayName: 'glpi.example.com',
  account: 'me'
}

// A single numeric-keyed search row, shaped like a /search/Ticket result.
const searchRow = {
  '1': 'Printer is down',
  '2': 514,
  '3': 5,
  '10': 4,
  '12': 2,
  '14': 1,
  '15': '2026-06-01 09:00:00',
  '19': '2026-06-02 10:00:00',
  '27': 2
}

const expectedTicket = {
  id: 514,
  serverId: 'srv-1',
  serverName: 'glpi.example.com',
  title: 'Printer is down',
  status: 'assigned',
  urgency: 4,
  priority: 5,
  type: 'incident',
  assignees: [],
  url: 'https://glpi.example.com/front/ticket.form.php?id=514',
  followups: 2,
  createdAt: '2026-06-01 09:00:00',
  updatedAt: '2026-06-02 10:00:00'
}

// The search path is whichever request call targets /search/Ticket.
function searchPath(): string {
  const call = request.mock.calls.find((c) => String(c[1]).startsWith('/search/Ticket'))
  if (!call) {
    throw new Error('no /search/Ticket request was made')
  }
  return String(call[1])
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listGlpiTickets', () => {
  it('filters assigned tickets by the resolved viewer as technician', async () => {
    request.mockImplementation(async (_server, path) => {
      if (String(path) === '/getFullSession') {
        return { session: { glpiID: 8 } } as never
      }
      return { data: [searchRow] } as never
    })

    await expect(listGlpiTickets(server, 'assigned', 30)).resolves.toEqual([expectedTicket])

    expect(request).toHaveBeenCalledWith(server, '/getFullSession')
    const query = searchPath()
    // Technician criterion (field 5) equals the viewer id (8).
    expect(query).toContain('field]=5')
    expect(query).toContain('value]=8')
    // Open-status pseudo value.
    expect(query).toContain('field]=12')
    expect(query).toContain(encodeURIComponent('notold'))
  })

  it('filters created tickets by the resolved viewer as requester', async () => {
    request.mockImplementation(async (_server, path) => {
      if (String(path) === '/getFullSession') {
        return { session: { glpiID: 8 } } as never
      }
      return { data: [searchRow] } as never
    })

    await expect(listGlpiTickets(server, 'created', 30)).resolves.toEqual([expectedTicket])

    expect(request).toHaveBeenCalledWith(server, '/getFullSession')
    const query = searchPath()
    // Requester criterion (field 4) equals the viewer id (8).
    expect(query).toContain('field]=4')
    expect(query).toContain('value]=8')
  })

  it('lists closed tickets with the old status and no viewer lookup', async () => {
    request.mockResolvedValue({ data: [searchRow] } as never)

    await expect(listGlpiTickets(server, 'closed', 30)).resolves.toEqual([expectedTicket])

    expect(request).not.toHaveBeenCalledWith(server, '/getFullSession')
    const query = searchPath()
    expect(query).toContain('field]=12')
    expect(query).toContain(encodeURIComponent('old'))
    // No technician/requester criterion for closed.
    expect(query).not.toContain('field]=5')
    expect(query).not.toContain('field]=4')
  })

  it('lists all open tickets with no user criterion and no viewer lookup', async () => {
    request.mockResolvedValue({ data: [searchRow] } as never)

    await expect(listGlpiTickets(server, 'all', 30)).resolves.toEqual([expectedTicket])

    expect(request).not.toHaveBeenCalledWith(server, '/getFullSession')
    const query = searchPath()
    expect(query).toContain('field]=12')
    expect(query).toContain(encodeURIComponent('notold'))
    expect(query).not.toContain('field]=5')
    expect(query).not.toContain('field]=4')
  })
})

describe('getGlpiTicket', () => {
  it('resolves the requester from the type-1 link and assignees from type-2 links', async () => {
    request.mockImplementation(async (_server, path) => {
      const p = String(path)
      if (p === '/Ticket/514?expand_dropdowns=0') {
        return {
          id: 514,
          name: 'Printer is down',
          status: 2,
          urgency: 4,
          priority: 5,
          type: 1,
          date: '2026-06-01 09:00:00',
          date_mod: '2026-06-02 10:00:00'
        } as never
      }
      if (p === '/Ticket/514/Ticket_User') {
        return [
          { users_id: 81, type: 2 },
          { users_id: 5, type: 1 }
        ] as never
      }
      if (p === '/User/81') {
        return { id: 81, name: 'tech', firstname: 'Tina', realname: 'Tech' } as never
      }
      if (p === '/User/5') {
        return { id: 5, name: 'ada', firstname: 'Ada', realname: 'Lovelace' } as never
      }
      throw new Error(`unexpected path ${p}`)
    })

    const ticket = await getGlpiTicket(server, 514)

    expect(ticket).not.toBeNull()
    expect(ticket?.requester).toEqual({ id: 5, login: 'ada', fullName: 'Ada Lovelace' })
    expect(ticket?.assignees).toEqual([{ id: 81, login: 'tech', fullName: 'Tina Tech' }])
    // Guards the detail fetch staying on raw (expand_dropdowns=0): numeric
    // status/urgency/priority/type must map correctly, not collapse to defaults.
    expect(ticket?.status).toBe('assigned')
    expect(ticket?.urgency).toBe(4)
    expect(ticket?.priority).toBe(5)
    expect(ticket?.type).toBe('incident')
  })
})

describe('addGlpiFollowup', () => {
  it('posts an ITILFollowup tied to the ticket and reports success', async () => {
    request.mockResolvedValue(undefined as never)

    await expect(addGlpiFollowup(server, 514, 'On my way')).resolves.toEqual({ ok: true })

    const call = request.mock.calls.find((c) => String(c[1]) === '/ITILFollowup')
    expect(call).toBeDefined()
    const init = call?.[2] as { method?: string; body?: string }
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body ?? '{}')).toEqual({
      input: { itemtype: 'Ticket', items_id: 514, content: 'On my way' }
    })
  })

  it('reports the error message when the request throws', async () => {
    request.mockRejectedValue(new Error('boom'))

    await expect(addGlpiFollowup(server, 514, 'On my way')).resolves.toEqual({
      ok: false,
      error: 'boom'
    })
  })
})

describe('updateGlpiTicket', () => {
  it('PUTs the ticket with the status mapped to its numeric code', async () => {
    request.mockResolvedValue(undefined as never)

    await expect(updateGlpiTicket(server, 514, { status: 'solved' })).resolves.toEqual({ ok: true })

    const call = request.mock.calls.find((c) => String(c[1]) === '/Ticket/514')
    expect(call).toBeDefined()
    const init = call?.[2] as { method?: string; body?: string }
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body ?? '{}').input.status).toBe(5)
  })

  it('makes no request when there is nothing to update', async () => {
    await expect(updateGlpiTicket(server, 514, {})).resolves.toEqual({ ok: true })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('createGlpiTicket', () => {
  it('POSTs a new ticket with the type mapped to its numeric code', async () => {
    request.mockResolvedValue({ id: 99 } as never)

    await expect(createGlpiTicket(server, { title: 'x', type: 'request' })).resolves.toEqual({
      ok: true,
      id: 99,
      url: 'https://glpi.example.com/front/ticket.form.php?id=99'
    })

    const call = request.mock.calls.find((c) => String(c[1]) === '/Ticket')
    expect(call).toBeDefined()
    const init = call?.[2] as { method?: string; body?: string }
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body ?? '{}').input.type).toBe(2)
  })
})
