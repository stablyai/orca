import { describe, expect, it } from 'vitest'
import { extractJiraConnection, jiraSiteLabel } from './jira-mobile-connection'

const siteA = {
  id: 'site-a',
  siteUrl: 'https://a.atlassian.net',
  email: 'me@example.com',
  displayName: 'Site A',
  accountId: 'acc-1'
}
const siteB = { ...siteA, id: 'site-b', siteUrl: 'https://b.atlassian.net', displayName: 'Site B' }

describe('extractJiraConnection', () => {
  it('treats an unreadable status as disconnected instead of throwing', () => {
    // A host predating the Jira RPCs answers with an error, which reaches us as null.
    for (const value of [null, undefined, 'nope', 42]) {
      expect(extractJiraConnection(value)).toEqual({
        connected: false,
        sites: [],
        selection: null,
        credentialError: null
      })
    }
  })

  it('keeps the credential error when a saved connection cannot be decrypted', () => {
    expect(
      extractJiraConnection({
        connected: false,
        viewer: null,
        credentialError: '  keychain locked  '
      })
    ).toEqual({
      connected: false,
      sites: [],
      selection: null,
      credentialError: 'keychain locked'
    })
  })

  it('honors an explicit all-sites selection', () => {
    const result = extractJiraConnection({
      connected: true,
      viewer: null,
      sites: [siteA, siteB],
      selectedSiteId: 'all'
    })
    expect(result.selection).toBe('all')
    expect(result.sites).toHaveLength(2)
  })

  it('falls back to the active site when the saved selection was disconnected', () => {
    const result = extractJiraConnection({
      connected: true,
      viewer: null,
      sites: [siteB],
      selectedSiteId: 'site-a',
      activeSiteId: 'site-b'
    })
    expect(result.selection).toBe('site-b')
  })

  it('falls back to the first site when neither selection nor active site resolves', () => {
    const result = extractJiraConnection({
      connected: true,
      viewer: null,
      sites: [siteA, siteB],
      selectedSiteId: 'gone',
      activeSiteId: 'also-gone'
    })
    expect(result.selection).toBe('site-a')
  })

  it('reports connected with no selection when the site list is empty', () => {
    const result = extractJiraConnection({ connected: true, viewer: null, sites: [] })
    expect(result).toMatchObject({ connected: true, selection: null })
  })
})

describe('jiraSiteLabel', () => {
  it('prefers the display name', () => {
    expect(jiraSiteLabel(siteA)).toBe('Site A')
  })

  it('falls back to a bare host when the display name is blank', () => {
    expect(jiraSiteLabel({ ...siteA, displayName: '   ' })).toBe('a.atlassian.net')
  })
})
