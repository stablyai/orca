import { mkdtempSync, rmSync } from 'node:fs'
import type * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (actual) => ({
  ...(await actual<typeof os>()),
  homedir: () => home.dir
}))

const { saveGoogleAccount } = await import('./google-credential-store')
const { googleApi } = await import('./google-api-client')
const { pickCalendar, listCalendars } = await import('./google-calendar-read')

const NOW = 1_800_000_000_000
const EMAIL = 'reader@example.com'

beforeEach(async () => {
  home.dir = mkdtempSync(join(tmpdir(), 'google-calendar-list-'))
  await saveGoogleAccount({
    email: EMAIL,
    client: { clientId: 'id', clientSecret: 'secret' },
    refreshToken: 'refresh',
    accessToken: 'access',
    expiresAt: NOW + 3_600_000,
    grantedScopes: [],
    status: 'connected',
    services: [],
    connectedAt: NOW
  })
})

afterEach(() => rmSync(home.dir, { recursive: true, force: true }))

it('resolves calendar names across every calendarList page', async () => {
  const api = await googleApi(EMAIL, {
    now: () => NOW,
    http: async (input) =>
      Response.json(
        new URL(String(input)).searchParams.get('pageToken') === 'second'
          ? {
              items: [
                { id: 'room@example.com', summary: 'Boardroom' },
                { id: 'two@example.com', summary: 'Planning' }
              ]
            }
          : { items: [{ id: 'one@example.com', summary: 'Planning' }], nextPageToken: 'second' }
      )
  })

  expect((await pickCalendar(api, 'boardroom')).id).toBe('room@example.com')
  await expect(pickCalendar(api, 'Planning')).rejects.toThrow(
    'Several calendars are named "Planning"; pass one\'s id: one@example.com, two@example.com.'
  )
})

it('refuses calendar results when the page limit leaves the list incomplete', async () => {
  const api = await googleApi(EMAIL, {
    now: () => NOW,
    http: async (input) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/primary')) {
        return Response.json({ id: 'primary@example.com', summary: 'Personal' })
      }
      if (url.pathname.endsWith('/one%40example.com')) {
        return Response.json({ id: 'one@example.com', summary: 'Planning' })
      }
      const page = Number(url.searchParams.get('pageToken') ?? '1')
      return Response.json({
        items: page === 1 ? [{ id: 'one@example.com', summary: 'Planning' }] : [],
        nextPageToken: String(page + 1)
      })
    }
  })

  await expect(pickCalendar(api, 'Planning')).rejects.toThrow('the listing is incomplete')
  await expect(listCalendars(api, NOW)).rejects.toThrow('the listing is incomplete')
  expect((await pickCalendar(api, 'one@example.com')).id).toBe('one@example.com')
  expect((await pickCalendar(api, 'primary')).id).toBe('primary@example.com')
})
