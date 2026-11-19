import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pollServerSignInRequest,
  ServerSignInRequestRetryableError,
  ServerSignInRequestUnsupportedError,
  startServerSignInRequest,
  type ServerSignInRequestBody
} from './orca-cloud-server-sign-in-requests'

const CONFIG = { apiBaseUrl: 'https://login.example.test' }
const BODY: ServerSignInRequestBody = {
  clientId: 'orca-server',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256',
  state: 'host-state',
  nonce: 'nonce',
  scope: 'openid',
  machineLabel: 'devbox',
  machinePlatform: 'linux',
  localProfileId: 'profile-1'
}
const CLAIM = { requestId: 'req-1', claimToken: 'claim-secret' }
const REDIRECT = 'https://login.example.test/v1/server-sign-in/verify?request=req-1'

function answer(status: number, json: unknown) {
  return vi.fn(
    async (_url: URL, _init?: RequestInit) => new Response(JSON.stringify(json), { status })
  )
}

const signal = () => new AbortController().signal

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('server sign-in requests', () => {
  it('starts a request with the PKCE challenge and machine binding, never the verifier', async () => {
    const fetch = answer(201, {
      requestId: 'req-1',
      claimToken: 'claim-secret',
      userCode: 'WDJB-MJHT',
      verificationUrl: 'https://login.example.test/device',
      intervalSeconds: 5,
      expiresInSeconds: 600
    })
    vi.stubGlobal('fetch', fetch)

    await expect(startServerSignInRequest(CONFIG, BODY, signal())).resolves.toMatchObject({
      requestId: 'req-1',
      userCode: 'WDJB-MJHT'
    })
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(String(url)).toBe('https://login.example.test/v1/server-sign-in/requests')
    expect(JSON.parse(String(init?.body))).toEqual(BODY)
  })

  it.each([
    ['a code with a terminal escape', { userCode: 'WDJB-\u001b[2J' }, 'unexpected format'],
    ['a code in another shape', { userCode: 'wdjb mjht' }, 'unexpected format'],
    [
      'a link with a control character',
      { verificationUrl: 'https://login.example.test/v1/\u001b]8;;x\u0007verify' },
      'cannot show'
    ],
    ['a link that is not http(s)', { verificationUrl: 'javascript:alert(1)' }, 'cannot show']
  ])('refuses %s, since both are printed in a terminal', async (_label, override, message) => {
    vi.stubGlobal(
      'fetch',
      answer(201, {
        requestId: 'req-1',
        claimToken: 'claim-secret',
        userCode: 'WDJB-MJHT',
        verificationUrl: 'https://login.example.test/v1/server-sign-in/verify?request=req-1',
        intervalSeconds: 5,
        expiresInSeconds: 600,
        ...override
      })
    )

    await expect(startServerSignInRequest(CONFIG, BODY, signal())).rejects.toThrow(message)
  })

  it('passes on the parsed link, not the raw string', async () => {
    vi.stubGlobal(
      'fetch',
      answer(201, {
        requestId: 'req-1',
        claimToken: 'claim-secret',
        userCode: 'WDJB-MJHT',
        verificationUrl: 'HTTPS://LOGIN.example.test:443/v1/server-sign-in/verify?request=req-1',
        intervalSeconds: 5,
        expiresInSeconds: 600
      })
    )

    await expect(startServerSignInRequest(CONFIG, BODY, signal())).resolves.toMatchObject({
      verificationUrl: 'https://login.example.test/v1/server-sign-in/verify?request=req-1'
    })
  })

  it('reads a missing endpoint as an Orca Cloud without server sign-in', async () => {
    vi.stubGlobal('fetch', answer(404, {}))

    await expect(startServerSignInRequest(CONFIG, BODY, signal())).rejects.toBeInstanceOf(
      ServerSignInRequestUnsupportedError
    )
  })

  it('refuses a request answer that is missing a field', async () => {
    vi.stubGlobal('fetch', answer(200, { requestId: 'req-1', claimToken: 'claim-secret' }))

    await expect(startServerSignInRequest(CONFIG, BODY, signal())).rejects.toThrow(
      'without userCode'
    )
  })

  it.each([
    [{ status: 'pending' }, { status: 'pending' }],
    [{ status: 'slow_down' }, { status: 'slow_down' }],
    [{ status: 'denied' }, { status: 'denied' }],
    [{ status: 'expired' }, { status: 'expired' }],
    [
      { status: 'slow_down', intervalSeconds: 10 },
      { status: 'slow_down', intervalSeconds: 10 }
    ],
    [
      { status: 'approved', code: 'one-time', redirectUri: REDIRECT },
      { status: 'approved', code: 'one-time', redirectUri: REDIRECT }
    ]
  ])('reads the poll answer %j', async (json, expected) => {
    const fetch = answer(200, json)
    vi.stubGlobal('fetch', fetch)

    await expect(pollServerSignInRequest(CONFIG, CLAIM, signal())).resolves.toEqual(expected)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(String(url)).toBe('https://login.example.test/v1/server-sign-in/requests/poll')
    expect(JSON.parse(String(init?.body))).toEqual(CLAIM)
  })

  it.each([
    ['an approval without redirectUri', 200, { status: 'approved', code: 'one-time' }],
    ['an approval without a code', 200, { status: 'approved', redirectUri: REDIRECT }],
    ['an unknown status', 200, { status: 'already_claimed' }]
  ])('refuses %s instead of guessing', async (_label, status, json) => {
    vi.stubGlobal('fetch', answer(status, json))

    await expect(pollServerSignInRequest(CONFIG, CLAIM, signal())).rejects.toThrow(
      `Orca Cloud answered ${status} while waiting for approval. Start again.`
    )
  })

  it('treats unknown_request as final, not something to retry', async () => {
    vi.stubGlobal('fetch', answer(404, { error: 'unknown_request' }))

    const error = await pollServerSignInRequest(CONFIG, CLAIM, signal()).catch((e) => e)

    expect(error).not.toBeInstanceOf(ServerSignInRequestRetryableError)
    expect(error.message).toBe('Orca Cloud no longer knows this sign-in. Start again.')
  })

  it('treats 5xx and network trouble as retryable, with messages that never carry the claim token', async () => {
    vi.stubGlobal('fetch', answer(503, {}))
    const unavailable = await pollServerSignInRequest(CONFIG, CLAIM, signal()).catch((e) => e)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed: claim-secret')
      })
    )
    const offline = await pollServerSignInRequest(CONFIG, CLAIM, signal()).catch((e) => e)
    vi.stubGlobal('fetch', answer(400, { error: 'bad' }))
    const refused = await pollServerSignInRequest(CONFIG, CLAIM, signal()).catch((e) => e)

    expect(unavailable).toBeInstanceOf(ServerSignInRequestRetryableError)
    expect(offline).toBeInstanceOf(ServerSignInRequestRetryableError)
    expect(refused).not.toBeInstanceOf(ServerSignInRequestRetryableError)
    for (const error of [unavailable, offline, refused]) {
      expect(String(error.message)).not.toContain('claim-secret')
      expect(error.cause).toBeUndefined()
    }
  })

  describe('over real HTTP', () => {
    const servers: Server[] = []

    afterEach(async () => {
      await Promise.all(
        servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
      )
    })

    async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
      const server = createServer(handler)
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('test server has no port')
      }
      return `http://127.0.0.1:${address.port}`
    }

    it.each([307, 308])(
      'never resends the claim token to a %i redirect target, and stops',
      async (code) => {
        const received: string[] = []
        const target = await listen((req, res) => {
          req.on('data', (chunk) => received.push(String(chunk)))
          req.on('end', () => res.end('{"status":"pending"}'))
        })
        const cloud = await listen((_req, res) => {
          res.writeHead(code, { location: `${target}/v1/server-sign-in/requests/poll` })
          res.end()
        })

        const error = await pollServerSignInRequest({ apiBaseUrl: cloud }, CLAIM, signal()).catch(
          (e) => e
        )

        expect(error).toBeInstanceOf(Error)
        expect(error).not.toBeInstanceOf(ServerSignInRequestRetryableError)
        expect(error.message).not.toContain('claim-secret')
        expect(received).toEqual([])
      }
    )
  })
})
