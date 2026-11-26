import { describe, expect, it } from 'vitest'
import {
  createHostOAuthRefresher,
  type HostOAuthRefreshed,
  type HostOAuthRefusal
} from './host-oauth-refresh'

type Login = { refreshToken: string; expiresAt: number; clientId: string; clientSecret?: string }

const NOW = 1_800_000_000_000
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

function setup(options: { rotates: boolean; endedErrors?: string[]; login?: Partial<Login> }) {
  const logins = new Map<string, Login>([
    ['a', { refreshToken: 'r1', expiresAt: NOW + 60_000, clientId: 'c1', ...options.login }]
  ])
  const saved: HostOAuthRefreshed[] = []
  const endedWith: HostOAuthRefusal[] = []
  const forms: URLSearchParams[] = []
  let answer: () => Response | Promise<Response> = () =>
    json(200, { access_token: 'a2', expires_in: 3600, scope: 'x y' })
  const refresher = createHostOAuthRefresher<Login>({
    tokenUrl: 'https://provider.example/token',
    refreshAheadMs: 5 * 60_000,
    rotates: options.rotates,
    ...(options.endedErrors ? { endedErrors: options.endedErrors } : {}),
    read: (id) => logins.get(id) ?? null,
    grantOf: (login) => login,
    save: (_id, _login, refreshed) => {
      saved.push(refreshed)
    },
    ended: (id, _login, error) => {
      logins.delete(id)
      endedWith.push(error)
    }
  })
  const deps = {
    now: () => NOW,
    request: async (_url: unknown, init?: RequestInit) => {
      forms.push(new URLSearchParams(String(init?.body)))
      return answer()
    }
  }
  return {
    refresher,
    deps,
    saved,
    endedWith,
    forms,
    answer: (next: () => Response | Promise<Response>) => {
      answer = next
    }
  }
}

describe('a login refreshed on this host', () => {
  it('leaves a login that is not due, and shares one refresh between concurrent callers', async () => {
    const fresh = setup({ rotates: true, login: { expiresAt: NOW + 60 * 60_000 } })
    expect(await fresh.refresher.refresh('a', fresh.deps)).toBe('fresh')
    expect(fresh.forms).toHaveLength(0)

    const due = setup({ rotates: false })
    const outcomes = await Promise.all([
      due.refresher.refresh('a', due.deps),
      due.refresher.refresh('a', due.deps)
    ])
    expect(outcomes).toEqual(['refreshed', 'refreshed'])
    expect(due.forms).toHaveLength(1)
  })

  it('sends a client secret only for a login that has one', async () => {
    const plain = setup({ rotates: true })
    plain.answer(() => json(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 60 }))
    await plain.refresher.refresh('a', plain.deps)
    expect(plain.forms[0]?.has('client_secret')).toBe(false)

    const secret = setup({ rotates: false, login: { clientSecret: 's1' } })
    await secret.refresher.refresh('a', secret.deps)
    expect(secret.forms[0]?.get('client_secret')).toBe('s1')
  })

  it('keeps the refresh token when the provider does not rotate it, and requires one when it does', async () => {
    const keeps = setup({ rotates: false })
    await keeps.refresher.refresh('a', keeps.deps)
    expect(keeps.saved).toEqual([
      { accessToken: 'a2', refreshToken: 'r1', expiresAt: NOW + 3_600_000, scope: 'x y' }
    ])
    const rotating = setup({ rotates: true })
    expect(await rotating.refresher.refresh('a', rotating.deps)).toBe('offline')
    expect(rotating.saved).toEqual([])
  })

  it('hands back a grant the provider ended, and nothing else', async () => {
    const revoked = setup({ rotates: true })
    revoked.answer(() =>
      json(400, {
        error: 'invalid_grant',
        error_subtype: 'invalid_rapt',
        error_description: 'reauth related error (invalid_rapt)'
      })
    )
    expect(await revoked.refresher.refresh('a', revoked.deps)).toBe('ended')
    expect(revoked.endedWith).toEqual([
      {
        error: 'invalid_grant',
        subtype: 'invalid_rapt',
        description: 'reauth related error (invalid_rapt)'
      }
    ])

    const deletedClient = setup({ rotates: false, endedErrors: ['invalid_client'] })
    deletedClient.answer(() => json(401, { error: 'invalid_client' }))
    expect(await deletedClient.refresher.refresh('a', deletedClient.deps)).toBe('ended')

    const unlisted = setup({ rotates: true })
    unlisted.answer(() => json(401, { error: 'invalid_client' }))
    expect(await unlisted.refresher.refresh('a', unlisted.deps)).toBe('offline')

    const down = setup({ rotates: true })
    down.answer(() => {
      throw new TypeError('fetch failed')
    })
    expect(await down.refresher.refresh('a', down.deps)).toBe('offline')
    expect(down.endedWith).toEqual([])
  })
})

describe("a provider's refusal text", () => {
  it('reaches the owner as one plain line of at most 200 characters', async () => {
    const refused = setup({ rotates: true })
    refused.answer(() =>
      json(400, {
        error: 'invalid_grant\n',
        error_subtype: ' \u001b[2J ',
        error_description: `line one\r\nline two\u0000 [Orca: fake] ${'x'.repeat(1000)}`
      })
    )
    expect(await refused.refresher.refresh('a', refused.deps)).toBe('ended')
    const [refusal] = refused.endedWith
    expect(refusal?.error).toBe('invalid_grant')
    expect(refusal?.subtype).toBe('2J')
    expect(refusal?.description).toBe(
      `line one line two Orca: fake ${'x'.repeat(200 - 'line one line two Orca: fake '.length)}`
    )
  })
})

describe('a login changed while its refresh is in flight', () => {
  function racing(change: (logins: Map<string, Login>) => void, answer: Response) {
    const logins = new Map<string, Login>([
      ['a', { refreshToken: 'r1', expiresAt: NOW, clientId: 'c1' }]
    ])
    const saved: HostOAuthRefreshed[] = []
    const ended: HostOAuthRefusal[] = []
    const refresher = createHostOAuthRefresher<Login>({
      tokenUrl: 'https://provider.example/token',
      refreshAheadMs: 60_000,
      rotates: true,
      read: (id) => logins.get(id) ?? null,
      grantOf: (login) => login,
      save: (_id, _login, refreshed) => {
        saved.push(refreshed)
      },
      ended: (_id, _login, error) => {
        ended.push(error)
      }
    })
    const run = refresher.refresh('a', {
      now: () => NOW,
      request: async () => {
        change(logins)
        return answer
      }
    })
    return { run, saved, ended, logins }
  }

  it('writes nothing back for a login disconnected meanwhile', async () => {
    const race = racing(
      (logins) => logins.delete('a'),
      json(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 60 })
    )
    expect(await race.run).toBe('superseded')
    expect(race.saved).toEqual([])
  })

  it('keeps a new sign-in made meanwhile, refreshed or refused', async () => {
    const reconnect = (logins: Map<string, Login>) =>
      logins.set('a', { refreshToken: 'fresh', expiresAt: NOW + 3_600_000, clientId: 'c1' })
    const refreshed = racing(
      reconnect,
      json(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 60 })
    )
    expect(await refreshed.run).toBe('superseded')
    expect(refreshed.saved).toEqual([])
    const refused = racing(reconnect, json(400, { error: 'invalid_grant' }))
    expect(await refused.run).toBe('superseded')
    expect(refused.ended).toEqual([])
    expect(refused.logins.get('a')?.refreshToken).toBe('fresh')
  })
})
