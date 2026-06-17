import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CredentialsModule from './credentials'
import { getStatus, trelloDownload, trelloRequest, TrelloApiError, isAuthError } from './client'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn(() => 'token-1')
  }
}))

vi.mock('./credentials', () => ({
  deleteTrelloCredentials: vi.fn(),
  getTrelloCredentialsMetadata: vi.fn(() => ({
    apiKey: 'key-1',
    viewer: { id: 'me', username: 'me', displayName: 'Me' },
    hasToken: true
  })),
  loadTrelloToken: vi.fn(() => 'token-1'),
  saveTrelloCredentials: vi.fn(),
  updateTrelloViewer: vi.fn()
}))

const { deleteTrelloCredentials, loadTrelloToken } = await import('./credentials')

describe('Trello client downloads', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/attachments/a-1')) {
          return Response.json({
            id: 'a-1',
            url: 'https://trello.com/1/cards/card-1/attachments/a-1/download/image.png',
            mimeType: 'image/png',
            fileName: 'image.png'
          })
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' }
        })
      })
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('authenticates api.trello.com attachment downloads with Trello OAuth header', async () => {
    const result = await trelloDownload(
      'https://api.trello.com/1/cards/card-1/attachments/a-1/download/image.png'
    )

    expect(result.contentType).toBe('image/png')
    expect(result.contentBase64).toBe('AQID')
    const metadataUrl = new URL(vi.mocked(fetch).mock.calls[0]?.[0] as string)
    expect(metadataUrl.pathname).toBe('/1/cards/card-1/attachments/a-1')
    expect(metadataUrl.searchParams.get('key')).toBe('key-1')
    expect(metadataUrl.searchParams.get('token')).toBe('token-1')

    const requestedUrl = new URL(vi.mocked(fetch).mock.calls[1]?.[0] as string)
    expect(requestedUrl.hostname).toBe('trello.com')
    expect(requestedUrl.searchParams.get('key')).toBeNull()
    expect(requestedUrl.searchParams.get('token')).toBeNull()
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Authorization: 'OAuth oauth_consumer_key="key-1", oauth_token="token-1"'
      }
    })
  })

  it('downloads the attachment URL returned by Trello metadata', async () => {
    await trelloDownload('https://trello.com/1/cards/card-1/attachments/a-1/download/stale.png')

    const requestedUrl = new URL(vi.mocked(fetch).mock.calls[1]?.[0] as string)
    expect(requestedUrl.pathname).toBe('/1/cards/card-1/attachments/a-1/download/image.png')
  })

  it('rejects non-Trello download hosts', async () => {
    await expect(
      trelloDownload('https://example.com/1/cards/card-1/download/image.png')
    ).rejects.toThrow('Unsupported Trello image URL.')
  })

  it('rejects attachment URLs returned by Trello that point to non-Trello hosts (SSRF)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/attachments/a-1')) {
          return Response.json({
            id: 'a-1',
            url: 'https://evil.example.com/steal?token=secret',
            mimeType: 'image/png',
            fileName: 'image.png'
          })
        }
        return new Response('should not be reached', { status: 200 })
      })
    )

    await expect(
      trelloDownload('https://trello.com/1/cards/card-1/attachments/a-1/download/image.png')
    ).rejects.toThrow('Attachment URL is not hosted on Trello.')

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('rejects attachment URLs returned by Trello that use http protocol (SSRF)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/attachments/a-1')) {
          return Response.json({
            id: 'a-1',
            url: 'http://trello.com/1/cards/card-1/attachments/a-1/download/image.png',
            mimeType: 'image/png',
            fileName: 'image.png'
          })
        }
        return new Response('should not be reached', { status: 200 })
      })
    )

    await expect(
      trelloDownload('https://trello.com/1/cards/card-1/attachments/a-1/download/image.png')
    ).rejects.toThrow('Attachment URL must use HTTPS.')

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('uses the concurrency limiter (acquire/release) around downloads', async () => {
    const results = await Promise.all([
      trelloDownload('https://trello.com/1/cards/card-1/attachments/a-1/download/image.png'),
      trelloDownload('https://trello.com/1/cards/card-1/attachments/a-1/download/image.png'),
      trelloDownload('https://trello.com/1/cards/card-1/attachments/a-1/download/image.png')
    ])

    for (const r of results) {
      expect(r.contentType).toBe('image/png')
      expect(r.contentBase64).toBe('AQID')
    }
  })
})

describe('Trello client credential clearing', () => {
  beforeEach(() => {
    vi.mocked(deleteTrelloCredentials).mockClear()
  })

  it('does not clear credentials on 403 permission errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ message: 'permission denied', error: 'Forbidden' }, { status: 403 })
      )
    )

    await expect(trelloRequest('/boards/some-board')).rejects.toThrow()

    expect(vi.mocked(deleteTrelloCredentials)).not.toHaveBeenCalled()
  })

  it('clears credentials on 401 unauthorized errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ message: 'invalid token', error: 'unauthorized' }, { status: 401 })
      )
    )

    await expect(trelloRequest('/boards/some-board')).rejects.toThrow()

    expect(vi.mocked(deleteTrelloCredentials)).toHaveBeenCalledTimes(1)
  })

  it('does not clear credentials on 403 during download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/attachments/a-1')) {
          return Response.json({
            id: 'a-1',
            url: 'https://trello.com/1/cards/card-1/attachments/a-1/download/image.png',
            mimeType: 'image/png',
            fileName: 'image.png'
          })
        }
        return new Response('forbidden', { status: 403, statusText: 'Forbidden' })
      })
    )

    await expect(
      trelloDownload('https://trello.com/1/cards/card-1/attachments/a-1/download/image.png')
    ).rejects.toThrow()

    expect(vi.mocked(deleteTrelloCredentials)).not.toHaveBeenCalled()
  })

  it('clears credentials on 401 during download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/attachments/a-1')) {
          return Response.json({
            id: 'a-1',
            url: 'https://trello.com/1/cards/card-1/attachments/a-1/download/image.png',
            mimeType: 'image/png',
            fileName: 'image.png'
          })
        }
        return new Response('unauthorized', { status: 401, statusText: 'Unauthorized' })
      })
    )

    await expect(
      trelloDownload('https://trello.com/1/cards/card-1/attachments/a-1/download/image.png')
    ).rejects.toThrow()

    expect(vi.mocked(deleteTrelloCredentials)).toHaveBeenCalledTimes(1)
  })
})

describe('isAuthError', () => {
  it('identifies 401 as an auth error', () => {
    expect(isAuthError(new TrelloApiError('unauthorized', 401))).toBe(true)
  })

  it('identifies 403 as an auth error', () => {
    expect(isAuthError(new TrelloApiError('forbidden', 403))).toBe(true)
  })

  it('rejects non-auth errors', () => {
    expect(isAuthError(new TrelloApiError('not found', 404))).toBe(false)
    expect(isAuthError(new Error('plain error'))).toBe(false)
  })
})

describe('getStatus', () => {
  it('reports disconnected when token is not readable', () => {
    vi.mocked(loadTrelloToken).mockReturnValueOnce(null)

    const status = getStatus()
    expect(status.connected).toBe(false)
    expect(status.viewer).toEqual({ id: 'me', username: 'me', displayName: 'Me' })
  })
})

describe('credential persistence (saveTrelloCredentials)', () => {
  it('updates in-memory cache after successful disk write', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const realCredentials = await vi.importActual<typeof CredentialsModule>('./credentials')
    const {
      saveTrelloCredentials,
      getTrelloCredentialsMetadata,
      loadTrelloToken,
      deleteTrelloCredentials,
      __setTestBaseDir
    } = realCredentials

    const tempDir = mkdtempSync(join(tmpdir(), 'trello-test-'))
    __setTestBaseDir(tempDir)
    try {
      saveTrelloCredentials('test-key', 'test-token', {
        id: 'u1',
        username: 'testuser',
        displayName: 'Test User'
      })

      const meta = getTrelloCredentialsMetadata()
      expect(meta.apiKey).toBe('test-key')
      expect(meta.viewer?.username).toBe('testuser')
      expect(meta.hasToken).toBe(true)
      expect(loadTrelloToken()).toBe('test-token')

      deleteTrelloCredentials()
    } finally {
      __setTestBaseDir(undefined)
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('clears in-memory credentials when switching test base directories', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const realCredentials = await vi.importActual<typeof CredentialsModule>('./credentials')
    const {
      saveTrelloCredentials,
      getTrelloCredentialsMetadata,
      loadTrelloToken,
      __setTestBaseDir
    } = realCredentials

    const firstDir = mkdtempSync(join(tmpdir(), 'trello-test-a-'))
    const secondDir = mkdtempSync(join(tmpdir(), 'trello-test-b-'))
    try {
      __setTestBaseDir(firstDir)
      saveTrelloCredentials('test-key', 'test-token', {
        id: 'u1',
        username: 'testuser',
        displayName: 'Test User'
      })
      expect(loadTrelloToken()).toBe('test-token')

      __setTestBaseDir(secondDir)
      expect(getTrelloCredentialsMetadata()).toEqual({ apiKey: '', viewer: null, hasToken: false })
      expect(loadTrelloToken()).toBeNull()
    } finally {
      __setTestBaseDir(undefined)
      rmSync(firstDir, { recursive: true, force: true })
      rmSync(secondDir, { recursive: true, force: true })
    }
  })
})
