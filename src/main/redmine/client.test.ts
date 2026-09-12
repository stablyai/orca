import { describe, expect, it, vi, beforeEach } from 'vitest'
import { classifyRedmineError, redmineRequest } from './redmine-request'
import {
  credentialErrors,
  deleteToken,
  getSiteFile,
  hasStoredToken,
  readToken,
  saveToken,
  writeSiteFile
} from './redmine-site-store'
import {
  _readRedmineTokenForTest,
  connectRedmineSite,
  disconnectRedmineSite,
  getRedmineStatus,
  redmineSiteForId,
  redmineSiteIdForUrl,
  testRedmineConnection
} from './client'
import type { RedmineReadError, RedmineSite } from '../../shared/redmine-types'
import type { RedmineSiteFile } from './redmine-site-store'
import { CredentialDecryptionError } from '../integration-credential-file'

vi.mock('./redmine-request', () => ({
  classifyRedmineError: vi.fn(),
  normalizeRedmineUrl: vi.fn((url: string) => url.replace(/\/+$/, '')),
  redmineRequest: vi.fn()
}))

vi.mock('./redmine-site-store', () => ({
  getSiteFile: vi.fn(),
  writeSiteFile: vi.fn(),
  saveToken: vi.fn(),
  deleteToken: vi.fn(),
  readToken: vi.fn(() => null),
  hasStoredToken: vi.fn(() => true),
  credentialErrors: {
    get: vi.fn(() => undefined),
    values: () => [][Symbol.iterator]()
  }
}))

const mockReadError = (type: RedmineReadError['type']): RedmineReadError => ({
  type,
  message: `msg:${type}`
})

const redmineRequestMock = vi.mocked(redmineRequest)
const classifyRedmineErrorMock = vi.mocked(classifyRedmineError)
const getSiteFileMock = vi.mocked(getSiteFile)
const writeSiteFileMock = vi.mocked(writeSiteFile)
const saveTokenMock = vi.mocked(saveToken)
const deleteTokenMock = vi.mocked(deleteToken)
const readTokenMock = vi.mocked(readToken)
const hasStoredTokenMock = vi.mocked(hasStoredToken)
const credentialErrorsGetMock = vi.mocked(credentialErrors.get)

function emptyFile(): RedmineSiteFile {
  return {
    version: 1,
    activeSiteId: null,
    selectedSiteId: null,
    sites: []
  }
}

function aSite(id: string, siteUrl: string): RedmineSite {
  return { id, siteUrl, displayName: new URL(siteUrl).hostname, hasToken: true }
}

beforeEach(() => {
  vi.clearAllMocks()
  hasStoredTokenMock.mockReturnValue(true)
  getSiteFileMock.mockReturnValue(emptyFile())
  writeSiteFileMock.mockImplementation((file) => {
    getSiteFileMock.mockReturnValue(file)
  })
})

describe('redmineSiteIdForUrl', () => {
  it('derives the site id from the normalized URL', () => {
    expect(redmineSiteIdForUrl('https://redmine.example.com/')).toBe('https://redmine.example.com')
  })
})

describe('testRedmineConnection', () => {
  it('returns the current user on success', async () => {
    redmineRequestMock.mockResolvedValue({
      user: { id: 7, firstname: 'Ada', lastname: 'Lovelace', login: 'ada' }
    })
    const result = await testRedmineConnection('https://redmine.example.com', 'secret')
    expect(result.user).toEqual({ id: 7, name: 'Ada Lovelace', login: 'ada' })
    expect(result.error).toBeUndefined()
  })

  it('folds a not_found read error into an unknown connection error', async () => {
    redmineRequestMock.mockRejectedValue(mockReadError('not_found'))
    classifyRedmineErrorMock.mockReturnValue(mockReadError('not_found'))
    const result = await testRedmineConnection('https://redmine.example.com', 'secret')
    expect(result.user).toBeNull()
    expect(result.error?.type).toBe('unknown')
  })

  it('preserves an auth error type', async () => {
    redmineRequestMock.mockRejectedValue(mockReadError('auth'))
    classifyRedmineErrorMock.mockReturnValue(mockReadError('auth'))
    const result = await testRedmineConnection('https://redmine.example.com', 'secret')
    expect(result.error?.type).toBe('auth')
  })
})

describe('connectRedmineSite', () => {
  it('persists the token and writes a site entry on success', async () => {
    redmineRequestMock.mockResolvedValue({
      user: { id: 1, firstname: 'Grace', lastname: 'Hopper' }
    })
    const result = await connectRedmineSite('https://redmine.example.com/', 'secret')
    expect(result.ok).toBe(true)
    expect(saveTokenMock).toHaveBeenCalledWith('https://redmine.example.com', 'secret')
    expect(writeSiteFileMock).toHaveBeenCalled()
    const written = writeSiteFileMock.mock.calls[0][0]
    expect(written.sites[0].id).toBe('https://redmine.example.com')
    expect(written.activeSiteId).toBe('https://redmine.example.com')
  })

  it('does not persist when the connection test fails', async () => {
    redmineRequestMock.mockRejectedValue(mockReadError('network'))
    classifyRedmineErrorMock.mockReturnValue(mockReadError('network'))
    const result = await connectRedmineSite('https://redmine.example.com', 'secret')
    expect(result.ok).toBe(false)
    expect(saveTokenMock).not.toHaveBeenCalled()
    expect(writeSiteFileMock).not.toHaveBeenCalled()
  })
})

describe('getRedmineStatus', () => {
  it('reports disconnected when no site has a stored token', () => {
    hasStoredTokenMock.mockReturnValue(false)
    getSiteFileMock.mockReturnValue({ ...emptyFile() })
    const status = getRedmineStatus()
    expect(status.connected).toBe(false)
    expect(status.activeSite).toBeNull()
  })

  it('reports a decryption error when the active site token cannot be decoded', () => {
    getSiteFileMock.mockReturnValue({
      ...emptyFile(),
      activeSiteId: 'site-a',
      selectedSiteId: 'site-a',
      sites: [aSite('site-a', 'https://a.example.com')]
    })
    credentialErrorsGetMock.mockReturnValue('cannot decrypt')
    const status = getRedmineStatus()
    expect(status.connected).toBe(true)
    expect(status.error).toEqual({ type: 'decryption', message: 'cannot decrypt' })
  })

  it('detects a corrupt token on the first status call (before any readToken attempt)', () => {
    getSiteFileMock.mockReturnValue({
      ...emptyFile(),
      activeSiteId: 'site-a',
      selectedSiteId: 'site-a',
      sites: [aSite('site-a', 'https://a.example.com')]
    })
    credentialErrorsGetMock.mockReturnValue(undefined)
    readTokenMock.mockImplementation(() => {
      throw new CredentialDecryptionError('Redmine')
    })
    const status = getRedmineStatus()
    expect(status.error?.type).toBe('decryption')
  })
})

describe('disconnectRedmineSite', () => {
  it('removes the site, clears the token, and promotes the next site', () => {
    getSiteFileMock.mockReturnValue({
      ...emptyFile(),
      activeSiteId: 'site-a',
      selectedSiteId: 'site-a',
      sites: [aSite('site-a', 'https://a.example.com'), aSite('site-b', 'https://b.example.com')]
    })
    disconnectRedmineSite('site-a')
    expect(deleteTokenMock).toHaveBeenCalledWith('site-a')
    const written = writeSiteFileMock.mock.calls[0][0]
    expect(written.sites.map((s: { id: string }) => s.id)).toEqual(['site-b'])
    expect(written.activeSiteId).toBe('site-b')
  })
})

describe('redmineSiteForId / token readback', () => {
  it('finds a site by id and exposes its stored token for tests', () => {
    getSiteFileMock.mockReturnValue({
      ...emptyFile(),
      sites: [aSite('site-a', 'https://a.example.com')]
    })
    readTokenMock.mockReturnValue('decoded-secret')
    expect(redmineSiteForId('site-a')?.siteUrl).toBe('https://a.example.com')
    expect(redmineSiteForId('missing')).toBeNull()
    expect(_readRedmineTokenForTest('site-a')).toBe('decoded-secret')
  })
})
