import { describe, expect, it, vi, beforeEach } from 'vitest'
import { buildRegistry, type RpcHandler } from '../core'
import { REDMINE_METHODS } from './redmine'
import {
  connectRedmineSite,
  disconnectRedmineSite,
  getRedmineStatus,
  redmineReadErrorForCredentials,
  resolveRedmineCredentials,
  testRedmineConnection
} from '../../../redmine/client'
import { getRedmineIssue, listRedmineIssues, RedmineRequestError } from '../../../redmine/issues'

vi.mock('../../../redmine/client', () => ({
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

vi.mock('../../../redmine/issues', () => ({
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

const registry = buildRegistry(REDMINE_METHODS)
const ctx = {} as Parameters<RpcHandler<unknown>>[1]

const site = {
  id: 'https://rm.example.com',
  siteUrl: 'https://rm.example.com',
  displayName: 'rm',
  hasToken: true
}

function connectedStatus() {
  return {
    connected: true,
    activeSite: site,
    selectedSiteId: site.id,
    viewer: null,
    error: null
  }
}
function disconnectedStatus() {
  return { connected: false, activeSite: null, selectedSiteId: null, viewer: null, error: null }
}

async function invoke(name: string, params?: unknown): Promise<unknown> {
  const method = registry.get(name)
  if (!method || 'stream' in method) {
    throw new Error(`method not found: ${name}`)
  }
  return method.handler(params, ctx)
}

beforeEach(() => {
  vi.clearAllMocks()
  getRedmineStatusMock.mockReturnValue(disconnectedStatus())
  resolveRedmineCredentialsMock.mockReturnValue({ ok: false, reason: 'no_site' })
  redmineReadErrorForCredentialsMock.mockReturnValue({
    type: 'auth',
    message: 'No Redmine site connected.'
  })
})

describe('REDMINE_METHODS registration', () => {
  it('exposes the six read/connect methods', () => {
    expect([...registry.keys()].sort()).toEqual([
      'redmine.connect',
      'redmine.disconnect',
      'redmine.getIssue',
      'redmine.listIssues',
      'redmine.status',
      'redmine.testConnection'
    ])
  })
})

describe('redmine.status', () => {
  it('returns the current site status', async () => {
    getRedmineStatusMock.mockReturnValue(connectedStatus())
    expect(await invoke('redmine.status')).toEqual(connectedStatus())
  })
})

describe('redmine.connect / testConnection', () => {
  it('trims and forwards connect params', async () => {
    connectRedmineSiteMock.mockResolvedValue({
      ok: true,
      site,
      viewer: { id: 1, name: 'A', login: 'a' }
    })
    const result = await invoke('redmine.connect', {
      siteUrl: '  https://rm.example.com  ',
      apiKey: '  secret  '
    })
    expect(connectRedmineSiteMock).toHaveBeenCalledWith('https://rm.example.com', 'secret')
    expect(result).toMatchObject({ ok: true })
  })

  it('wraps a successful testConnection into the ok shape', async () => {
    testRedmineConnectionMock.mockResolvedValue({
      user: { id: 1, name: 'Ada', login: 'ada' }
    })
    const result = await invoke('redmine.testConnection', {
      siteUrl: 'https://rm.example.com',
      apiKey: 'k'
    })
    expect(result).toEqual({ ok: true, user: { id: 1, name: 'Ada', login: 'ada' } })
  })

  it('wraps a failed testConnection into ok:false', async () => {
    testRedmineConnectionMock.mockResolvedValue({
      user: null,
      error: { type: 'auth', message: 'bad key' }
    })
    const result = await invoke('redmine.testConnection', {
      siteUrl: 'https://rm.example.com',
      apiKey: 'nope'
    })
    expect(result).toEqual({ ok: false, error: { type: 'auth', message: 'bad key' } })
  })
})

describe('redmine.disconnect', () => {
  it('forwards a valid site id', async () => {
    await invoke('redmine.disconnect', { siteId: 'site-a' })
    expect(disconnectRedmineSiteMock).toHaveBeenCalledWith('site-a')
  })

  it('ignores a missing site id', async () => {
    await invoke('redmine.disconnect', undefined)
    expect(disconnectRedmineSiteMock).not.toHaveBeenCalled()
  })
})

describe('redmine.listIssues', () => {
  it('returns an auth error when no site is connected', async () => {
    const result = await invoke('redmine.listIssues', { filter: { scope: 'assigned' } })
    expect(result).toEqual({
      items: [],
      totalCount: 0,
      error: { type: 'auth', message: 'No Redmine site connected.' }
    })
    expect(listRedmineIssuesMock).not.toHaveBeenCalled()
  })

  it('lists issues with the active site credentials', async () => {
    resolveRedmineCredentialsMock.mockReturnValue({
      ok: true,
      siteUrl: 'https://rm.example.com',
      apiKey: 'secret'
    })
    listRedmineIssuesMock.mockResolvedValue({ items: [], totalCount: 0 })
    await invoke('redmine.listIssues', { filter: { scope: 'assigned' } })
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
    const err = new RedmineRequestError({ type: 'auth', message: 'Invalid API key' }, null)
    ;(err as { classified?: unknown }).classified = {
      type: 'auth',
      message: 'Invalid API key'
    }
    listRedmineIssuesMock.mockRejectedValue(err)
    const result = await invoke('redmine.listIssues', {})
    expect(result).toEqual({
      items: [],
      totalCount: 0,
      error: { type: 'auth', message: 'Invalid API key' }
    })
  })
})

describe('redmine.getIssue', () => {
  it('returns an error when no site is connected', async () => {
    expect(await invoke('redmine.getIssue', { issueId: 1 })).toEqual({
      issue: null,
      error: { type: 'auth', message: 'No Redmine site connected.' }
    })
  })

  it('fetches the issue through the active site', async () => {
    resolveRedmineCredentialsMock.mockReturnValue({
      ok: true,
      siteUrl: 'https://rm.example.com',
      apiKey: 'secret'
    })
    getRedmineIssueMock.mockResolvedValue({ id: 1 } as never)
    const result = await invoke('redmine.getIssue', { issueId: 1 })
    expect(getRedmineIssueMock).toHaveBeenCalledWith('https://rm.example.com', 'secret', 1)
    expect(result).toEqual({ issue: { id: 1 } })
  })

  it('surfaces a decryption reason as an error', async () => {
    resolveRedmineCredentialsMock.mockReturnValue({ ok: false, reason: 'decryption' })
    redmineReadErrorForCredentialsMock.mockReturnValue({
      type: 'auth',
      message: 'Your stored Redmine API key could not be decrypted. Reconnect to re-enter it.'
    })
    const result = await invoke('redmine.getIssue', { issueId: 1 })
    expect(result).toEqual({
      issue: null,
      error: {
        type: 'auth',
        message: 'Your stored Redmine API key could not be decrypted. Reconnect to re-enter it.'
      }
    })
  })
})
