import assert from 'node:assert/strict'
import test from 'node:test'
import { requestGitHubSmokeTokens } from './github-smoke-token.mjs'

const jwt = (value) => `${value}.${value}.${value}`

test('exchanges the runner OIDC token without returning request credentials', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    if (requests.length === 1) return Response.json({ value: jwt('github') })
    return Response.json({
      accessTokens: Object.fromEntries(
        ['owner', 'recipient', 'outsider'].map((name) => [
          name,
          { userId: `usr_${name}`, accessToken: jwt(name), expiresAt: Date.now() + 600_000 }
        ])
      )
    })
  }
  const result = await requestGitHubSmokeTokens(
    'https://auth-staging.onorca.dev',
    fetchImpl,
    {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example.test/token?api-version=1',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token'
    }
  )
  assert.equal(result.owner.userId, 'usr_owner')
  assert.match(requests[0].url, /audience=https%3A%2F%2Fauth-staging\.onorca\.dev/)
  assert.equal(requests[0].init.headers.authorization, 'Bearer runner-request-token')
  assert.equal(requests[1].init.headers.authorization, `Bearer ${jwt('github')}`)
})

test('fails with bounded errors and never includes credentials', async () => {
  await assert.rejects(
    requestGitHubSmokeTokens(
      'https://auth-staging.onorca.dev',
      async () => new Response('denied', { status: 403 }),
      {
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example.test/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-request-token'
      }
    ),
    (error) => {
      assert.doesNotMatch(String(error), /private-request-token|denied/)
      return true
    }
  )
})

test('requests and validates an exact Relay Asia principal batch', async () => {
  const requests = []
  const principals = Array.from({ length: 32 }, (_, principalIndex) => {
    const suffix = String(principalIndex).padStart(32, 'a')
    return {
      principalIndex,
      userId: `usr_relay_asia_load_${suffix}`,
      profileId: `prof_relay_asia_load_${suffix}`,
      accessToken: jwt(`load${principalIndex}`),
      expiresAt: Date.now() + 600_000
    }
  })
  const result = await requestGitHubSmokeTokens(
    'https://auth-staging.onorca.dev',
    async (url, init) => {
      requests.push({ url: String(url), init })
      return requests.length === 1
        ? Response.json({ value: jwt('github') })
        : Response.json({
            accessTokens: Object.fromEntries(['owner', 'recipient', 'outsider'].map((name) => [
              name,
              { userId: `usr_${name}`, accessToken: jwt(name), expiresAt: Date.now() + 600_000 }
            ])),
            relayAsiaLoadPrincipals: principals
          })
    },
    {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example.test/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token'
    },
    { relayAsiaLoad: { shardIndex: 3, principalCount: 32 } }
  )
  assert.equal(result.relayAsiaLoadPrincipals.length, 32)
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    relayAsiaLoad: { v: 1, shardIndex: 3, principalCount: 32 }
  })
  assert.equal(requests[1].init.headers['content-type'], 'application/json')
})

test('rejects malformed or duplicate Relay Asia principal batches', async () => {
  const environment = {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example.test/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token'
  }
  let request = 0
  await assert.rejects(requestGitHubSmokeTokens(
    'https://auth-staging.onorca.dev',
    async () => ++request === 1
      ? Response.json({ value: jwt('github') })
      : Response.json({
          accessTokens: Object.fromEntries(['owner', 'recipient', 'outsider'].map((name) => [
            name,
            { userId: `usr_${name}`, accessToken: jwt(name), expiresAt: Date.now() + 600_000 }
          ])),
          relayAsiaLoadPrincipals: []
        }),
    environment,
    { relayAsiaLoad: { shardIndex: 0, principalCount: 32 } }
  ), /principal response is invalid/)
})
