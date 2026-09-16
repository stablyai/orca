import { describe, expect, it, vi, beforeEach } from 'vitest'
import { registerRedmineHandlers } from './redmine'
import {
  connectRedmineSite,
  disconnectRedmineSite,
  getRedmineStatus,
  redmineReadErrorForCredentials,
  resolveRedmineCredentials,
  testRedmineConnection
} from '../redmine/client'
import { getRedmineIssue, listRedmineIssues, RedmineRequestError } from '../redmine/issues'

const { handlers } = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: unknown, args?: unknown) => Promise<unknown>>
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args?: unknown) => Promise<unknown>) => {
      handlers[channel] = fn
    }
  }
}))

vi.mock('../redmine/client', () => ({
  connectRedmineSite: vi.fn(),
  disconnectRedmineSite: vi.fn(),
  getRedmineStatus: vi.fn(),
  redmineReadErrorForCredentials: vi.fn(() => ({
    type: 'auth',
    message: 'No Redmine site connected.'
  })),
  resolveRedmineCredentials: vi.fn(() => ({ ok: false, reason: 'no_site' })),
  testRedmineConnection: vi.fn()
}))

vi.mock('../redmine/issues', () => ({
  getRedmineIssue: vi.fn(),
  listRedmineIssues: vi.fn(),
  RedmineRequestError: class RedmineRequestError extends Error {}
}))

const connectRedmineSiteMock = vi.mocked(connectRedmineSite)
const disconnectRedmineSiteMock = vi.mocked(disconnectRedmineSite)
const getRedmineStatusMock = vi.mocked(getRedmineStatus)
const redmineReadErrorForCredentialsMock = vi.mocked(redmineReadErrorForCredentials)
const resolveRedmineCredentialsMock = vi.mocked(resolveRedmineCredentials)
const testRedmineConnectionMock = vi.mocked(testRedmineConnection)
const getRedmineIssueMock = vi.mocked(getRedmineIssue)
const listRedmineIssuesMock = vi.mocked(listRedmineIssues)

const invoke = (channel: string, args?: unknown) => handlers[channel](null, args)

const site = {
  id: 'https://rm.example.com',
  siteUrl: 'https://rm.example.com',
  displayName: 'rm',
  hasToken: true
}

function connectedStatus() {
  return { connected: true, activeSite: site, selectedSiteId: site.id, viewer: null, error: null }
}
function disconnectedStatus() {
  return { connected: false, activeSite: null, selectedSiteId: null, viewer: null, error: null }
}

beforeEach(() => {
  vi.clearAllMocks()
  getRedmineStatusMock.mockReturnValue(disconnectedStatus())
  resolveRedmineCredentialsMock.mockReturnValue({ ok: false, reason: 'no_site' })
  redmineReadErrorForCredentialsMock.mockReturnValue({
    type: 'auth',
    message: 'No Redmine site connected.'
  })
  registerRedmineHandlers()
})

describe('redmine:connect', () => {
  it('rejects when required fields are missing', async () => {
    expect(await invoke('redmine:connect', {})).toEqual({
      ok: false,
      error: { type: 'unknown', message: 'Server URL and API key are required.' }
    })
    expect(connectRedmineSiteMock).not.toHaveBeenCalled()
  })

  it('trims and forwards the connection when fields are present', async () => {
    connectRedmineSiteMock.mockResolvedValue({
      ok: true,
      site,
      viewer: { id: 1, name: 'Ada', login: 'ada' }
    })
    const result = await invoke('redmine:connect', {
      siteUrl: '  https://rm.example.com  ',
      apiKey: '  secret  '
    })
    expect(connectRedmineSiteMock).toHaveBeenCalledWith('https://rm.example.com', 'secret')
    expect(result).toEqual({
      ok: true,
      site,
      viewer: { id: 1, name: 'Ada', login: 'ada' }
    })
  })

  it('maps a failed connection to ok:false', async () => {
    connectRedmineSiteMock.mockResolvedValue({
      ok: false,
      error: { type: 'auth', message: 'bad' }
    })
    const result = await invoke('redmine:connect', {
      siteUrl: 'https://rm.example.com',
      apiKey: 'nope'
    })
    expect(result).toEqual({ ok: false, error: { type: 'auth', message: 'bad' } })
  })
})

describe('redmine:status', () => {
  it('forwards the current status', async () => {
    getRedmineStatusMock.mockReturnValue(connectedStatus())
    expect(await invoke('redmine:status')).toEqual(connectedStatus())
  })
})

describe('redmine:listIssues', () => {
  it('returns an auth error when no site is connected', async () => {
    const result = await invoke('redmine:listIssues', { filter: { scope: 'assigned' } })
    expect(result).toEqual({
      items: [],
      totalCount: 0,
      error: { type: 'auth', message: 'No Redmine site connected.' }
    })
    expect(listRedmineIssuesMock).not.toHaveBeenCalled()
  })

  it('surfaces a decryption reason as a reconnect error', async () => {
    resolveRedmineCredentialsMock.mockReturnValue({ ok: false, reason: 'decryption' })
    redmineReadErrorForCredentialsMock.mockReturnValue({
      type: 'auth',
      message: 'Your stored Redmine API key could not be decrypted. Reconnect to re-enter it.'
    })
    const result = await invoke('redmine:listIssues', {})
    expect(result).toEqual({
      items: [],
      totalCount: 0,
      error: {
        type: 'auth',
        message: 'Your stored Redmine API key could not be decrypted. Reconnect to re-enter it.'
      }
    })
    expect(listRedmineIssuesMock).not.toHaveBeenCalled()
  })

  it('lists issues using the active site token', async () => {
    resolveRedmineCredentialsMock.mockReturnValue({
      ok: true,
      siteUrl: 'https://rm.example.com',
      apiKey: 'secret'
    })
    listRedmineIssuesMock.mockResolvedValue({ items: [], totalCount: 0 })
    await invoke('redmine:listIssues', { filter: { scope: 'assigned' } })
    expect(listRedmineIssuesMock).toHaveBeenCalledWith('https://rm.example.com', 'secret', {
      scope: 'assigned'
    })
  })

  it('returns the classified error when the upstream request fails', async () => {
    resolveRedmineCredentialsMock.mockReturnValue({
      ok: true,
      siteUrl: 'https://rm.example.com',
      apiKey: 'secret'
    })
    const err = new RedmineRequestError(
      { type: 'network', message: 'Network request failed' },
      null
    )
    ;(err as { classified?: unknown }).classified = {
      type: 'network',
      message: 'Network request failed'
    }
    listRedmineIssuesMock.mockRejectedValue(err)
    const result = await invoke('redmine:listIssues', {})
    expect(result).toEqual({
      items: [],
      totalCount: 0,
      error: { type: 'network', message: 'Network request failed' }
    })
  })
})

describe('redmine:getIssue', () => {
  it('returns an error when no site is connected', async () => {
    expect(await invoke('redmine:getIssue', { issueId: 1 })).toEqual({
      issue: null,
      error: { type: 'auth', message: 'No Redmine site connected.' }
    })
  })

  it('returns issue:null for a non-finite issue id', async () => {
    resolveRedmineCredentialsMock.mockReturnValue({
      ok: true,
      siteUrl: 'https://rm.example.com',
      apiKey: 'secret'
    })
    expect(await invoke('redmine:getIssue', {})).toEqual({ issue: null })
    expect(getRedmineIssueMock).not.toHaveBeenCalled()
  })

  it('fetches the issue through the active site', async () => {
    resolveRedmineCredentialsMock.mockReturnValue({
      ok: true,
      siteUrl: 'https://rm.example.com',
      apiKey: 'secret'
    })
    const issue = { id: 1 } as never
    getRedmineIssueMock.mockResolvedValue(issue)
    const result = await invoke('redmine:getIssue', { issueId: 1 })
    expect(getRedmineIssueMock).toHaveBeenCalledWith('https://rm.example.com', 'secret', 1)
    expect(result).toEqual({ issue })
  })

  it('surfaces a decryption reason as an error', async () => {
    resolveRedmineCredentialsMock.mockReturnValue({ ok: false, reason: 'decryption' })
    redmineReadErrorForCredentialsMock.mockReturnValue({
      type: 'auth',
      message: 'Your stored Redmine API key could not be decrypted. Reconnect to re-enter it.'
    })
    const result = await invoke('redmine:getIssue', { issueId: 1 })
    expect(result).toEqual({
      issue: null,
      error: {
        type: 'auth',
        message: 'Your stored Redmine API key could not be decrypted. Reconnect to re-enter it.'
      }
    })
  })
})

describe('redmine:disconnect', () => {
  it('forwards a valid site id', async () => {
    await invoke('redmine:disconnect', { siteId: 'site-a' })
    expect(disconnectRedmineSiteMock).toHaveBeenCalledWith('site-a')
  })

  it('ignores a missing site id', async () => {
    await invoke('redmine:disconnect', undefined)
    expect(disconnectRedmineSiteMock).not.toHaveBeenCalled()
  })
})

describe('redmine:testConnection', () => {
  it('returns ok:true with the user on success', async () => {
    testRedmineConnectionMock.mockResolvedValue({ user: { id: 1, name: 'Ada', login: 'ada' } })
    const result = await invoke('redmine:testConnection', {
      siteUrl: 'https://rm.example.com',
      apiKey: 'k'
    })
    expect(result).toEqual({ ok: true, user: { id: 1, name: 'Ada', login: 'ada' } })
  })
})
