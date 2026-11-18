import { mkdtempSync, rmSync } from 'node:fs'
import { request, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests } from '../../../shared/secure-storage/secret-store'
import { announceBotToolCredentialsEnded } from '../bot-tool-credential-ended'
import { commitBotToolOAuth, useBotToolCredentialsRoot } from '../bot-tool-credentials'
import {
  botToolCredentialSource,
  type BotToolCredentialRequest,
  type BotToolCredentialSource
} from '../tool-oauth/bot-tool-credential-source'
import { BotToolRelay } from './bot-tool-relay'
import {
  call,
  closeUpstreams,
  json,
  upstream,
  installFakeSealingStore,
  writeToolsFile
} from './bot-tool-relay.test-fixtures'

const ID = 'cred-app-0001'
const dirs: string[] = []
let relay: BotToolRelay

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A sign-in whose token is renewed whenever a call reports the current one refused. */
function fakeSignIn(url: string) {
  const asked: Omit<BotToolCredentialRequest, 'signal'>[] = []
  /** Set to hold every answer until it resolves, like a token server that's slow to answer. */
  const hold: { until: Promise<void> | null } = { until: null }
  const state = { token: 'token-1', asked, hold }
  const source: BotToolCredentialSource = async ({ signal: _signal, ...request }) => {
    asked.push(request)
    await hold.until
    if (request.rejected === state.token) {
      state.token = `${state.token}-renewed`
    }
    return {
      kind: 'ready',
      url,
      headers: { authorization: `Bearer ${state.token}` },
      session: 'grant-1',
      bearer: state.token
    }
  }
  return { state, source }
}

async function grantBot(botId: string) {
  const folder = tempDir('relay-bot-')
  const { origin, token } = await relay.grant(botId, folder)
  const headers = { ...json, authorization: `Bearer ${token}` }
  return { folder, headers, address: `${origin}/bot-tools/${ID}/mcp` }
}

async function botUsing(source: BotToolCredentialSource) {
  relay.close()
  relay = new BotToolRelay((url, init) => fetch(url, init), source)
  return grantBot('scout')
}

/** Opens a call and hands back its response as soon as headers arrive, with what it streams. */
function open(
  address: string,
  options: { method: string; headers: Record<string, string>; body?: string }
) {
  const req = request(address, { method: options.method, headers: options.headers })
  req.on('error', () => {})
  req.end(options.body)
  return new Promise<{ response: IncomingMessage; text: () => string; closed: Promise<void> }>(
    (resolve) =>
      req.on('response', (response) => {
        let text = ''
        response.on('data', (chunk) => (text += chunk))
        response.on('error', () => {})
        const closed = new Promise<void>((done) => response.on('close', done))
        resolve({ response, text: () => text, closed })
      })
  )
}

const INITIALIZE = '{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}'
const TOOL_CALL = '{"jsonrpc":"2.0","id":"call-9","method":"tools/call","params":{"name":"x"}}'

beforeEach(() => {
  useBotToolCredentialsRoot(tempDir('relay-credentials-'))
  installFakeSealingStore()
  relay = new BotToolRelay((url, init) => fetch(url, init))
})
afterEach(() => {
  _resetSecretStoreForTests()
  relay.close()
  closeUpstreams()
  useBotToolCredentialsRoot(null)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('a tool Orca signs in to, through the relay', () => {
  it('shares one refresh between calls the app refused together', async () => {
    // The app is its own token server, and takes only the renewed token.
    const app = await upstream((seen, res) => {
      if (seen.path === '/.well-known/oauth-authorization-server') {
        const base = `http://${seen.headers.host}`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            response_types_supported: ['code']
          })
        )
      } else if (seen.path === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          '{"access_token":"access-2","token_type":"Bearer","refresh_token":"refresh-2","expires_in":3600}'
        )
      } else if (seen.headers.authorization === 'Bearer access-2') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(seen.body)
      } else {
        res.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"' })
        res.end()
      }
    })
    const bot = await botUsing(botToolCredentialSource())
    writeToolsFile(bot.folder, { [ID]: app.url })
    commitBotToolOAuth(bot.folder, ID, () => ({
      url: app.url,
      grant: 1,
      record: {
        resource: app.url,
        issuer: new URL(app.url).origin,
        client: { client_id: 'orca-client', token_endpoint_auth_method: 'none' },
        tokens: {
          access_token: 'access-1',
          token_type: 'Bearer',
          refresh_token: 'refresh-1'
        }
      }
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const answers = await Promise.all(
      [1, 2, 3].map((id) =>
        call(bot.address, {
          headers: bot.headers,
          body: `{"jsonrpc":"2.0","id":${id},"method":"ping"}`
        })
      )
    )

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200])
    expect(answers.map((answer) => answer.headers['www-authenticate'])).toEqual([
      undefined,
      undefined,
      undefined
    ])
    expect(answers.map((answer) => JSON.parse(answer.body).id)).toEqual([1, 2, 3])
    expect(app.seen.filter((seen) => seen.path === '/token')).toHaveLength(1)
  })

  it('retries a refused call once with the same body, session and protocol', async () => {
    let refuse = false
    const app = await upstream((seen, res) => {
      if (refuse && seen.headers.authorization === 'Bearer token-1') {
        res.writeHead(401, {
          'www-authenticate': 'Bearer resource_metadata="https://app.example/x"'
        })
        res.end('{"error":"invalid_token"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' })
      res.end('{"jsonrpc":"2.0","id":"call-9","result":{}}')
    })
    const { state, source } = fakeSignIn(app.url)
    const bot = await botUsing(source)
    await call(bot.address, { headers: bot.headers, body: INITIALIZE })
    refuse = true
    app.seen.length = 0
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const answer = await call(bot.address, {
      headers: {
        ...bot.headers,
        'mcp-session-id': 'session-1',
        'mcp-protocol-version': '2025-06-18'
      },
      body: TOOL_CALL
    })

    expect(answer.status).toBe(200)
    expect(answer.headers['www-authenticate']).toBeUndefined()
    expect(app.seen.map((seen) => seen.headers.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-1-renewed'
    ])
    expect(app.seen.map((seen) => seen.body)).toEqual([TOOL_CALL, TOOL_CALL])
    expect(app.seen.map((seen) => seen.headers['mcp-session-id'])).toEqual([
      'session-1',
      'session-1'
    ])
    expect(app.seen.map((seen) => seen.headers['mcp-protocol-version'])).toEqual([
      '2025-06-18',
      '2025-06-18'
    ])
    expect(state.asked.at(-1)?.rejected).toBe('token-1')
  })

  it('answers "sign in" per request after a second refusal, and never with a 401', async () => {
    const app = await upstream((_seen, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer error="invalid_token"' })
      res.end()
    })
    const bot = await botUsing(fakeSignIn(app.url).source)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const request = await call(bot.address, { headers: bot.headers, body: TOOL_CALL })
    expect(request.status).toBe(200)
    expect(request.headers['www-authenticate']).toBeUndefined()
    expect(JSON.parse(request.body)).toMatchObject({
      jsonrpc: '2.0',
      id: 'call-9',
      error: { code: -32001 }
    })
    // One refresh and one retry, no more.
    expect(app.seen).toHaveLength(2)

    const batch = await call(bot.address, {
      headers: bot.headers,
      body: `[${INITIALIZE},{"jsonrpc":"2.0","method":"notifications/initialized"}]`
    })
    expect(JSON.parse(batch.body).map((entry: { id: number }) => entry.id)).toEqual([7])
    const notification = await call(bot.address, {
      headers: bot.headers,
      body: '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    })
    expect(notification.status).toBe(202)
    expect((await call(bot.address, { method: 'GET', headers: bot.headers })).status).toBe(405)
  })

  it('ties an unavailable sign-in to the call it stopped, before the call and after a refresh', async () => {
    const app = await upstream((_seen, res) => {
      res.writeHead(401)
      res.end()
    })
    const { source } = fakeSignIn(app.url)
    let refreshes: 'fail' | 'throw' = 'fail'
    const bot = await botUsing(async (request) => {
      if (!request.rejected) {
        return source(request)
      }
      if (refreshes === 'throw') {
        throw new Error('the token commit failed')
      }
      return { kind: 'unavailable' }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const mode of ['fail', 'throw'] as const) {
      refreshes = mode
      const answer = await call(bot.address, { headers: bot.headers, body: TOOL_CALL })
      expect(answer.status).toBe(502)
      expect(JSON.parse(answer.body)).toMatchObject({ id: 'call-9', error: { code: -32000 } })
    }

    const unavailable = await botUsing(async () => ({ kind: 'unavailable' }))
    const before = await call(unavailable.address, {
      headers: unavailable.headers,
      body: INITIALIZE
    })
    expect(JSON.parse(before.body)).toMatchObject({ id: 7, error: { code: -32000 } })
  })

  it('answers "sign in" without calling the app when there is no sign-in', async () => {
    const app = await upstream((_seen, res) => res.end('{}'))
    const bot = await botUsing(async () => ({ kind: 'sign-in-needed' }))
    const answer = await call(bot.address, { headers: bot.headers, body: INITIALIZE })
    expect(JSON.parse(answer.body)).toMatchObject({ id: 7, error: { code: -32001 } })
    expect(app.seen).toHaveLength(0)
  })

  it('passes a permission refusal on without refreshing', async () => {
    const app = await upstream((_seen, res) => {
      res.writeHead(403, { 'www-authenticate': 'Bearer error="insufficient_scope", scope="write"' })
      res.end('{}')
    })
    const { state, source } = fakeSignIn(app.url)
    const bot = await botUsing(source)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answer = await call(bot.address, { headers: bot.headers, body: TOOL_CALL })
    expect(answer.status).toBe(403)
    expect(answer.headers['www-authenticate']).toBeUndefined()
    expect(state.asked.map((asked) => asked.rejected)).toEqual([undefined])
    expect(app.seen).toHaveLength(1)
    expect(relay.lastProblem(bot.folder, ID)).toContain('more access')
  })

  it('never replays a tool call whose stream had started', async () => {
    const app = await upstream((_seen, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n', () =>
        setTimeout(() => res.destroy(), 20)
      )
    })
    const { state, source } = fakeSignIn(app.url)
    const bot = await botUsing(source)
    const stream = await open(bot.address, {
      method: 'POST',
      headers: bot.headers,
      body: TOOL_CALL
    })
    await stream.closed
    expect(stream.text()).toContain('progress')
    expect(stream.response.complete).toBe(false)
    expect(app.seen).toHaveLength(1)
    expect(state.asked).toHaveLength(1)
  })

  it('gives an idle event stream its headers before any event', async () => {
    const app = await upstream((_seen, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
    })
    const bot = await botUsing(fakeSignIn(app.url).source)
    const stream = await open(bot.address, {
      method: 'GET',
      headers: { ...bot.headers, accept: 'text/event-stream' }
    })
    expect(stream.response.statusCode).toBe(200)
    expect(stream.response.headers['content-type']).toBe('text/event-stream')
    expect(stream.text()).toBe('')
  })

  it('tells a call cut while it waited for a token that the session ended', async () => {
    let waiting = false
    // Like Orca's source: a waiter that's cut answers "unavailable" rather than throwing.
    const bot = await botUsing(
      (request) =>
        new Promise((resolve) => {
          waiting = true
          request.signal.addEventListener('abort', () => resolve({ kind: 'unavailable' }))
        })
    )
    const answer = call(bot.address, { headers: bot.headers, body: TOOL_CALL })
    await vi.waitFor(() => expect(waiting).toBe(true))
    announceBotToolCredentialsEnded(bot.folder, [ID])
    expect((await answer).status).toBe(404)
  })

  it('cuts open streams and calls when the tool is removed, and ends its sessions', async () => {
    const app = await upstream((seen, res) => {
      if (seen.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {}\n\n')
      } else if (seen.body === INITIALIZE) {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' })
        res.end('{}')
      }
      // Anything else waits: a call still thinking when the tool goes.
    })
    const bot = await botUsing(fakeSignIn(app.url).source)
    await call(bot.address, { headers: bot.headers, body: INITIALIZE })
    const withSession = { ...bot.headers, 'mcp-session-id': 'session-1' }
    const stream = await open(bot.address, { method: 'GET', headers: withSession })
    const thinking = call(bot.address, { headers: withSession, body: TOOL_CALL })
    await vi.waitFor(() => expect(app.seen).toHaveLength(3))

    announceBotToolCredentialsEnded(bot.folder, [ID])

    await stream.closed
    expect(stream.response.complete).toBe(false)
    expect((await thinking).status).toBe(404)
    // Its session isn't adopted by whatever sign-in comes next.
    expect((await call(bot.address, { headers: withSession, body: TOOL_CALL })).status).toBe(404)
  })

  it('makes a session it never saw under this sign-in start over', async () => {
    const app = await upstream((_seen, res) => res.end('{}'))
    const bot = await botUsing(fakeSignIn(app.url).source)
    const answer = await call(bot.address, {
      headers: { ...bot.headers, 'mcp-session-id': 'from-before-restart' },
      body: TOOL_CALL
    })
    expect(answer.status).toBe(404)
    expect(app.seen).toHaveLength(0)
  })

  it('counts calls waiting on a token against the bot’s limit', async () => {
    const app = await upstream((_seen, res) => res.end('{}'))
    const { state, source } = fakeSignIn(app.url)
    let release: () => void = () => {}
    state.hold.until = new Promise((resolve) => (release = resolve))
    const bot = await botUsing(source)
    const waiting = Array.from({ length: 16 }, () =>
      call(bot.address, { method: 'GET', headers: bot.headers })
    )
    await vi.waitFor(() => expect(state.asked).toHaveLength(16))
    expect((await call(bot.address, { method: 'GET', headers: bot.headers })).status).toBe(429)
    release()
    expect((await Promise.all(waiting)).map((answer) => answer.status)).toEqual(Array(16).fill(200))
  })

  it('keeps tool calls and session cleanup going when idle streams fill every stream slot', async () => {
    // Streams that never send an event, without holding hundreds of sockets to a server.
    const idleStreams: ReadableStreamDefaultController[] = []
    relay.close()
    relay = new BotToolRelay(
      async (_url, init) =>
        init.method === 'GET'
          ? new Response(new ReadableStream({ start: (stream) => void idleStreams.push(stream) }), {
              headers: { 'content-type': 'text/event-stream' }
            })
          : new Response('{}', { headers: { 'content-type': 'application/json' } }),
      fakeSignIn('https://app.example/mcp').source
    )
    const first = await grantBot('scout')
    const bots = [first]
    for (let n = 1; n <= 16; n += 1) {
      bots.push(await grantBot(`bot-${n}`))
    }
    const streaming = bots.slice(0, 16)
    const streams: Awaited<ReturnType<typeof open>>[] = []
    // A bot at a time: hundreds of connects at once overflow the OS's listen backlog.
    for (const bot of streaming) {
      streams.push(
        ...(await Promise.all(
          Array.from({ length: 16 }, () =>
            open(bot.address, { method: 'GET', headers: bot.headers })
          )
        ))
      )
    }
    expect(streams.map((stream) => stream.response.statusCode)).toEqual(Array(256).fill(200))
    const idle = bots[16]!
    // Every stream slot on this computer is taken...
    expect((await call(idle.address, { method: 'GET', headers: idle.headers })).status).toBe(429)
    // ...and calls and cleanup, from a streaming bot or another, still go through.
    for (const bot of [first, idle]) {
      expect((await call(bot.address, { headers: bot.headers, body: TOOL_CALL })).status).toBe(200)
      const cleanup = await call(bot.address, { method: 'DELETE', headers: bot.headers })
      expect(cleanup.status).toBe(200)
    }
  })
})
