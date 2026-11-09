import { describe, expect, it } from 'vitest'

import { extractJiraConnection, reconcileJiraConnection } from './jira-mobile-connection'

const siteA = {
  id: 'site-a',
  siteUrl: 'https://a.atlassian.net',
  email: 'me@example.com',
  displayName: 'Site A',
  accountId: 'acc-1'
}
const siteB = { ...siteA, id: 'site-b', siteUrl: 'https://b.atlassian.net', displayName: 'Site B' }

describe('Jira connection compatibility', () => {
  it('keeps the phone selection when desktop status is refreshed', () => {
    const next = extractJiraConnection({
      connected: true,
      sites: [siteA, siteB],
      selectedSiteId: 'site-a'
    })
    expect(reconcileJiraConnection({ ...next, selection: 'site-b' }, next).selection).toBe('site-b')
    expect(reconcileJiraConnection({ ...next, selection: 'all' }, next).selection).toBe('all')
    expect(reconcileJiraConnection({ ...next, selection: 'gone' }, next).selection).toBe('site-a')
  })
})
