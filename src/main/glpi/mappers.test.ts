import { describe, expect, it } from 'vitest'
import type { GlpiServer } from '../../shared/types'
import {
  glpiStatusToCode,
  glpiTicketUrl,
  glpiTypeToCode,
  mapGlpiFollowup,
  mapGlpiSearchRow,
  mapGlpiStatus,
  mapGlpiTicketDetail,
  mapGlpiType,
  mapGlpiUser
} from './mappers'

const server: GlpiServer = {
  id: 'srv-1',
  baseUrl: 'https://glpi.example.com',
  apiBaseUrl: 'https://glpi.example.com/apirest.php',
  displayName: 'glpi.example.com',
  account: 'me'
}

describe('mapGlpiStatus', () => {
  it('maps each numeric status code to its key', () => {
    expect(mapGlpiStatus(1)).toBe('new')
    expect(mapGlpiStatus(2)).toBe('assigned')
    expect(mapGlpiStatus(3)).toBe('planned')
    expect(mapGlpiStatus(4)).toBe('pending')
    expect(mapGlpiStatus(5)).toBe('solved')
    expect(mapGlpiStatus(6)).toBe('closed')
  })

  it('accepts string codes', () => {
    expect(mapGlpiStatus('2')).toBe('assigned')
    expect(mapGlpiStatus('6')).toBe('closed')
  })

  it('falls back to new for unknown or missing values', () => {
    expect(mapGlpiStatus(0)).toBe('new')
    expect(mapGlpiStatus(99)).toBe('new')
    expect(mapGlpiStatus(null)).toBe('new')
    expect(mapGlpiStatus(undefined)).toBe('new')
  })
})

describe('glpiStatusToCode', () => {
  it('round-trips each status back to its 1..6 code', () => {
    expect(glpiStatusToCode('new')).toBe(1)
    expect(glpiStatusToCode('assigned')).toBe(2)
    expect(glpiStatusToCode('planned')).toBe(3)
    expect(glpiStatusToCode('pending')).toBe(4)
    expect(glpiStatusToCode('solved')).toBe(5)
    expect(glpiStatusToCode('closed')).toBe(6)
  })

  it('is the inverse of mapGlpiStatus for every code', () => {
    for (let code = 1; code <= 6; code += 1) {
      expect(glpiStatusToCode(mapGlpiStatus(code))).toBe(code)
    }
  })
})

describe('mapGlpiType', () => {
  it('maps 2 to request and everything else to incident', () => {
    expect(mapGlpiType(2)).toBe('request')
    expect(mapGlpiType('2')).toBe('request')
    expect(mapGlpiType(1)).toBe('incident')
    expect(mapGlpiType(0)).toBe('incident')
    expect(mapGlpiType(null)).toBe('incident')
    expect(mapGlpiType(undefined)).toBe('incident')
  })
})

describe('glpiTypeToCode', () => {
  it('maps request to 2 and incident to 1', () => {
    expect(glpiTypeToCode('request')).toBe(2)
    expect(glpiTypeToCode('incident')).toBe(1)
  })
})

describe('glpiTicketUrl', () => {
  it('builds the GLPI ticket form URL', () => {
    expect(glpiTicketUrl('https://glpi.example.com', 514)).toBe(
      'https://glpi.example.com/front/ticket.form.php?id=514'
    )
  })
})

describe('mapGlpiUser', () => {
  it('builds a user with a full name joined from firstname and realname', () => {
    expect(mapGlpiUser({ id: 8, name: 'ada', firstname: 'Ada', realname: 'Lovelace' })).toEqual({
      id: 8,
      login: 'ada',
      fullName: 'Ada Lovelace'
    })
  })

  it('falls back to the id as login when name is missing', () => {
    expect(mapGlpiUser({ id: 8, firstname: 'Ada' })).toEqual({
      id: 8,
      login: '8',
      fullName: 'Ada'
    })
  })

  it('returns undefined fullName when no name parts are present', () => {
    expect(mapGlpiUser({ id: 8, name: 'ada' })).toEqual({
      id: 8,
      login: 'ada',
      fullName: undefined
    })
  })

  it('returns undefined when the id is missing', () => {
    expect(mapGlpiUser(undefined)).toBeUndefined()
    expect(mapGlpiUser(null)).toBeUndefined()
    expect(mapGlpiUser({ name: 'ada' })).toBeUndefined()
  })
})

describe('mapGlpiTicketDetail', () => {
  it('maps a raw ticket onto a GlpiTicket scoped to the server', () => {
    const ticket = mapGlpiTicketDetail(
      {
        id: 514,
        name: 'Printer is down',
        content: '<p>It is on fire</p>',
        status: 2,
        urgency: 4,
        priority: 5,
        type: 2,
        itilcategories_id: 'Hardware',
        date: '2026-06-01 09:00:00',
        date_mod: '2026-06-02 10:00:00'
      },
      server
    )

    expect(ticket).toEqual({
      id: 514,
      serverId: 'srv-1',
      serverName: 'glpi.example.com',
      title: 'Printer is down',
      content: '<p>It is on fire</p>',
      status: 'assigned',
      urgency: 4,
      priority: 5,
      type: 'request',
      category: 'Hardware',
      assignees: [],
      url: 'https://glpi.example.com/front/ticket.form.php?id=514',
      followups: 0,
      createdAt: '2026-06-01 09:00:00',
      updatedAt: '2026-06-02 10:00:00'
    })
  })
})

describe('mapGlpiSearchRow', () => {
  it('maps a numeric-keyed search row, including int status and followup count', () => {
    const ticket = mapGlpiSearchRow(
      {
        '1': 'Network outage',
        '2': 514,
        '3': 5,
        '10': 4,
        '12': 6,
        '14': 2,
        '15': '2026-06-01 09:00:00',
        '19': '2026-06-02 10:00:00',
        '27': 3
      },
      server
    )

    expect(ticket).toEqual({
      id: 514,
      serverId: 'srv-1',
      serverName: 'glpi.example.com',
      title: 'Network outage',
      status: 'closed',
      urgency: 4,
      priority: 5,
      type: 'request',
      assignees: [],
      url: 'https://glpi.example.com/front/ticket.form.php?id=514',
      followups: 3,
      createdAt: '2026-06-01 09:00:00',
      updatedAt: '2026-06-02 10:00:00'
    })
  })
})

describe('mapGlpiFollowup', () => {
  it('maps a raw followup and attaches the passed user', () => {
    const user = { id: 8, login: 'ada', fullName: 'Ada Lovelace' }
    expect(
      mapGlpiFollowup(
        {
          id: 12,
          content: 'Looking into it',
          date: '2026-06-02 10:00:00',
          users_id: 8,
          is_private: 1
        },
        user
      )
    ).toEqual({
      id: 12,
      content: 'Looking into it',
      isPrivate: true,
      createdAt: '2026-06-02 10:00:00',
      user
    })
  })

  it('treats is_private true the same as 1 and anything else as public', () => {
    expect(mapGlpiFollowup({ id: 1, is_private: true }).isPrivate).toBe(true)
    expect(mapGlpiFollowup({ id: 2, is_private: 0 }).isPrivate).toBe(false)
    expect(mapGlpiFollowup({ id: 3 }).isPrivate).toBe(false)
  })

  it('defaults missing content and date and leaves user undefined', () => {
    expect(mapGlpiFollowup({ id: 4 })).toEqual({
      id: 4,
      content: '',
      isPrivate: false,
      createdAt: '',
      user: undefined
    })
  })
})
