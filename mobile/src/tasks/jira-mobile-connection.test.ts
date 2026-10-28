import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import {
  extractJiraConnection,
  jiraSiteLabel,
  readJiraConnection,
  readJiraConnectionProbeReply,
  reconcileJiraConnection
} from './jira-mobile-connection'

const siteA = {
  id: 'site-a',
  siteUrl: 'https://a.atlassian.net',
  email: 'me@example.com',
  displayName: 'Site A',
  accountId: 'acc-1'
}
const siteB = { ...siteA, id: 'site-b', siteUrl: 'https://b.atlassian.net', displayName: 'Site B' }

describe('extractJiraConnection', () => {
  it('explains an unreadable status without blocking the remaining providers', () => {
    for (const value of [null, undefined, 'nope', 42]) {
      expect(extractJiraConnection(value)).toEqual({
        connected: false,
        sites: [],
        selection: null,
        credentialError: null,
        unavailableReason: 'Update Orca desktop to browse Jira on mobile.'
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
      credentialError: 'keychain locked',
      unavailableReason: null
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

describe('readJiraConnection', () => {
  it('reports a refused status read instead of showing it as disconnected', async () => {
    // Unauthorized Jira RPCs must not look like disconnected accounts and show an unsatisfiable setup prompt.
    const client = {
      sendRequest: async (): Promise<RpcResponse> => ({
        id: 'jira-test',
        ok: false,
        error: {
          code: 'UNAVAILABLE',
          message: "Method 'jira.status' is not available to mobile clients"
        }
      })
    }

    await expect(readJiraConnection(client)).rejects.toThrow(
      "Method 'jira.status' is not available to mobile clients"
    )
  })

  it('returns the parsed connection on success', async () => {
    const client = {
      sendRequest: async (): Promise<RpcResponse> => ({
        id: 'jira-test',
        ok: true,
        result: { connected: true, viewer: null, sites: [siteA], selectedSiteId: 'site-a' }
      })
    }

    await expect(readJiraConnection(client)).resolves.toMatchObject({
      connected: true,
      selection: 'site-a'
    })
  })
})

describe('Jira connection compatibility', () => {
  it('distinguishes an older host refusal from an actual disconnected site', () => {
    expect(
      readJiraConnectionProbeReply({
        id: 'jira-test',
        ok: false,
        error: { code: 'METHOD_NOT_FOUND', message: 'Not found' }
      })
    ).toMatchObject({
      connected: false,
      unavailableReason: 'Update Orca desktop to browse Jira on mobile.'
    })
    expect(
      readJiraConnectionProbeReply({ id: 'jira-test', ok: true, result: { connected: false } })
    ).toMatchObject({
      connected: false,
      unavailableReason: null
    })
  })

  it('salvages optional site fields while dropping sites that cannot be selected', () => {
    const connection = extractJiraConnection({
      connected: true,
      sites: [null, { id: 'bad' }, { ...siteA, email: 42, authType: 'future' }]
    })
    expect(connection.sites).toEqual([{ ...siteA, email: '', authType: undefined }])
  })

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
