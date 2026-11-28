import { expect, it } from 'vitest'
import { GoogleToolError, type GoogleApi } from './google-api-client'
import { suggestCalendarTime } from './google-calendar-free-time'

const api: GoogleApi = {
  email: 'owner@example.test',
  get: async () => {
    throw new Error('Unexpected Google read')
  },
  find: async (_service, url, read) => {
    if (url.endsWith('/calendarList/primary')) {
      return read({ id: 'primary', timeZone: 'UTC' })
    }
    throw new Error('Unexpected Google lookup')
  },
  send: async (_service, _write, read) => {
    const answer = read({ calendars: { primary: { busy: [] } } })
    if (answer === null) {
      throw new Error('Invalid free/busy answer')
    }
    return answer
  },
  bytes: async () => {
    throw new Error('Unexpected Google download')
  }
}

it('answers impossible minutes in --hours with the usage instead of an internal error', async () => {
  for (const hours of ['09:75-17:00', '09:00-17:60']) {
    await expect(
      suggestCalendarTime(api, { with: [], duration: '30m', hours, now: 0 })
    ).rejects.toThrow(GoogleToolError)
  }
  const view = await suggestCalendarTime(api, {
    with: [],
    duration: '30m',
    hours: '9:00-24:00',
    now: Date.parse('2026-11-03T09:00:00Z')
  })
  expect(view.hours).toEqual({ from: '09:00', to: '24:00' })
})
