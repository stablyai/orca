import { beforeEach, describe, expect, it, vi } from 'vitest'

type AccountState = {
  version: 1
  viewer: { id: string; username: string; email: string } | null
  workspaces: { id: string; name: string }[]
  selectedWorkspaceId: string | null
}

const EMPTY_STATE: AccountState = {
  version: 1,
  viewer: null,
  workspaces: [],
  selectedWorkspaceId: null
}
const VIEWER_A = { id: '1', username: 'a', email: 'a@example.com' }

const clickupRequest = vi.fn<(token: string, path: string) => Promise<unknown>>()
const store: { token: string | null; state: AccountState; failDelete: boolean } = {
  token: null,
  state: EMPTY_STATE,
  failDelete: false
}

vi.mock('./authenticated-request', () => ({ clickupRequest }))
vi.mock('./clickup-account-store', () => ({
  getAccountState: async () => store.state,
  readToken: async () => store.token,
  getCredentialError: async () => undefined,
  getTokenProtection: async () => null,
  inAccountOrder: async (run: () => Promise<unknown>) => run(),
  saveToken: async (token: string) => {
    store.token = token
  },
  deleteToken: async () => {
    if (store.failDelete) {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    }
    store.token = null
  },
  writeAccountState: async (state: AccountState) => {
    store.state = state
  }
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetModules()
  clickupRequest.mockReset()
  store.token = 'token-a'
  store.state = {
    version: 1,
    viewer: VIEWER_A,
    workspaces: [{ id: '9001', name: 'Acme' }],
    selectedWorkspaceId: '9001'
  }
  store.failDelete = false
})

describe('testConnection racing the account changing', () => {
  function holdVerification() {
    const user = deferred<unknown>()
    const requested = deferred<void>()
    clickupRequest.mockImplementation(async (_token, path) => {
      if (path !== '/user') {
        return { teams: [{ id: '9001', name: 'Renamed' }] }
      }
      requested.resolve()
      return user.promise
    })
    return {
      requested: requested.promise,
      finishVerification: () =>
        user.resolve({ user: { id: 1, username: 'a', email: 'a@example.com' } })
    }
  }

  it('does not restore the account of a token that a disconnect removed', async () => {
    const { testConnection, disconnect, getStatus } = await import('./client')
    const { requested, finishVerification } = holdVerification()

    const refresh = testConnection()
    await requested
    await disconnect()
    finishVerification()

    await expect(refresh).resolves.toMatchObject({ ok: false, errorCode: 'clickup.notConnected' })
    expect((await getStatus()).connected).toBe(false)
  })

  it('does not pair a reconnected token with the previous account', async () => {
    const { testConnection } = await import('./client')
    const { requested, finishVerification } = holdVerification()

    const refresh = testConnection()
    await requested
    store.token = 'token-b'
    store.state = {
      version: 1,
      viewer: { id: '2', username: 'b', email: 'b@example.com' },
      workspaces: [{ id: '7', name: 'Other' }],
      selectedWorkspaceId: '7'
    }
    finishVerification()

    await expect(refresh).resolves.toMatchObject({ ok: true, viewer: { id: '2' } })
    expect(store.state.workspaces).toEqual([{ id: '7', name: 'Other' }])
  })

  it('refreshes the account when nothing changed', async () => {
    const { testConnection } = await import('./client')
    const { requested, finishVerification } = holdVerification()

    const refresh = testConnection()
    await requested
    finishVerification()

    await expect(refresh).resolves.toMatchObject({ ok: true })
    expect(store.state.workspaces).toEqual([{ id: '9001', name: 'Renamed' }])
  })
})

describe('disconnect', () => {
  it('rejects and keeps the account when the token cannot be removed', async () => {
    const { disconnect } = await import('./client')
    store.failDelete = true

    await expect(disconnect()).rejects.toMatchObject({ code: 'EACCES' })
    expect(store.state.viewer).toEqual(VIEWER_A)
  })
})

describe('testConnection when ClickUp revokes the token', () => {
  it('reports the rejection and disconnects even when the token file cannot be deleted', async () => {
    const { testConnection, getStatus } = await import('./client')
    const { ClickUpApiError } = await import('./clickup-api-error')
    clickupRequest.mockRejectedValue(new ClickUpApiError('Token not found', 401, 'OAUTH_019'))
    store.failDelete = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(testConnection()).resolves.toMatchObject({
      ok: false,
      errorCode: 'clickup.connectionFailed'
    })
    expect((await getStatus()).connected).toBe(false)
    warn.mockRestore()
  })
})
