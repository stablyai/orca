import { expect, it } from 'vitest'
import type { GoogleApi } from './google-api-client'
import { updateCalendarEvent } from './google-calendar-write'

it('preserves exact event lengths when moving starts, including sub-minute events', async () => {
  for (const [originalEnd, movedEnd] of [
    ['2026-11-04T10:01:20.250Z', '2026-11-05T10:32:05.000Z'],
    ['2026-11-04T10:00:20.375Z', '2026-11-05T10:31:05.125Z']
  ]) {
    let stored = {
      id: 'event_a',
      start: { dateTime: '2026-11-04T10:00:00.250Z' },
      end: { dateTime: originalEnd }
    }
    const api: GoogleApi = {
      email: 'owner@example.test',
      get: async () => {
        throw new Error('Unexpected Google read')
      },
      find: async (_service, url, read) => {
        if (url.endsWith('/calendarList/primary')) {
          return read({ id: 'primary', timeZone: 'UTC' })
        }
        if (url.endsWith('/events/event_a')) {
          return read(stored)
        }
        throw new Error('Unexpected Google lookup')
      },
      send: async (_service, write, read) => {
        stored = Object.assign({}, stored, write.json)
        const response = read(stored)
        if (response === null) {
          throw new Error('Invalid Google event response')
        }
        return response
      },
      bytes: async () => {
        throw new Error('Unexpected Google download')
      }
    }

    await updateCalendarEvent(api, {
      ref: 'event_a',
      start: '2026-11-05T10:30:45',
      with: [],
      without: [],
      notify: false,
      now: 0
    })

    expect(stored).toMatchObject({
      start: { dateTime: '2026-11-05T10:30:45.000Z' },
      end: { dateTime: movedEnd }
    })
  }
})
