import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args?: unknown) => unknown>(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  status: vi.fn(),
  resetRepoRefCache: vi.fn(),
  resetPreflightCache: vi.fn(),
  invalidateReviews: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../bitbucket/server-credential-connection', () => ({
  connectBitbucketServer: mocks.connect,
  disconnectBitbucketServer: mocks.disconnect,
  getBitbucketServerConnectionStatus: mocks.status
}))
vi.mock('../bitbucket/server-repository-ref', () => ({
  _resetBitbucketServerRepoRefCache: mocks.resetRepoRefCache
}))
vi.mock('../source-control/hosted-review-branch-cache', () => ({
  invalidateAllHostedReviewBranchCaches: mocks.invalidateReviews
}))
vi.mock('../preflight/agent-detection', () => ({
  _resetPreflightCache: mocks.resetPreflightCache
}))

import { registerBitbucketServerHandlers } from './bitbucket-server'

function invoke(channel: string, args?: unknown): unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler({}, args)
}

describe('Bitbucket Server IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    registerBitbucketServerHandlers()
  })

  it('connects and resets detection caches on success', async () => {
    mocks.connect.mockResolvedValue({ ok: true, account: 'alice' })

    await expect(
      invoke('bitbucketServer:connect', { baseUrl: 'https://b.example.com', accessToken: 't0k' })
    ).resolves.toEqual({ ok: true, account: 'alice' })
    expect(mocks.connect).toHaveBeenCalledWith({
      baseUrl: 'https://b.example.com',
      accessToken: 't0k'
    })
    expect(mocks.resetRepoRefCache).toHaveBeenCalledOnce()
    expect(mocks.resetPreflightCache).toHaveBeenCalledOnce()
    expect(mocks.invalidateReviews).toHaveBeenCalledOnce()
  })

  it('keeps caches when the connection fails', async () => {
    mocks.connect.mockResolvedValue({ ok: false, error: 'nope' })

    await invoke('bitbucketServer:connect', { baseUrl: 'https://b.example.com', accessToken: 'x' })
    expect(mocks.resetRepoRefCache).not.toHaveBeenCalled()
  })

  it.each([null, 'text', { baseUrl: 1, accessToken: 't' }, { baseUrl: 'u' }])(
    'rejects malformed connect args %o',
    async (args) => {
      await expect(invoke('bitbucketServer:connect', args)).resolves.toEqual({
        ok: false,
        error: 'Invalid Bitbucket Server credentials'
      })
      expect(mocks.connect).not.toHaveBeenCalled()
    }
  )

  it('disconnects and resets detection caches', async () => {
    await invoke('bitbucketServer:disconnect')
    expect(mocks.disconnect).toHaveBeenCalledOnce()
    expect(mocks.resetRepoRefCache).toHaveBeenCalledOnce()
    expect(mocks.invalidateReviews).toHaveBeenCalledOnce()
  })

  it('returns status as provided by the connection module', async () => {
    const status = {
      configured: true,
      source: 'stored',
      credentialProtection: 'sealed',
      account: 'alice',
      baseUrl: 'https://b.example.com'
    }
    mocks.status.mockReturnValue(status)

    await expect(invoke('bitbucketServer:status')).resolves.toEqual(status)
  })
})
