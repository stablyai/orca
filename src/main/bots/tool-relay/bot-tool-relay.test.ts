import { mkdtempSync, rmSync } from 'node:fs'
import { request, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests } from '../../../shared/secure-storage/secret-store'
import { changeBotToolCredentials, useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { botToolCredentialSource } from '../tool-oauth/bot-tool-credential-source'
import { BotToolRelay, MCP_HOST_LIST_RELAY_OWNER } from './bot-tool-relay'
import {
  call,
  closeUpstreams,
  json,
  upstream,
  installFakeSealingStore,
  writeToolsFile
} from './bot-tool-relay.test-fixtures'

const SECRET = 'sk-live-secret-value'
const dirs: string[] = []
let relay: BotToolRelay

function toolsFolder(url: string, id: string, secret = SECRET): string {
  const folder = mkdtempSync(join(tmpdir(), 'relay-bot-'))
  dirs.push(folder)
  changeBotToolCredentials(folder, new Map([[id, { url, headers: { 'x-api-key': secret } }]]))
  writeToolsFile(folder, { [id]: url })
  return folder
}

async function botWith(url: string, botId = 'scout', id = 'cred-notion', secret = SECRET) {
  const folder = toolsFolder(url, id, secret)
  const { origin, token } = await relay.grant(botId, { bot: folder })
  return { folder, token, address: `${origin}/bot-tools/${id}/mcp` }
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'relay-credentials-'))
  dirs.push(root)
  useBotToolCredentialsRoot(root)
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

describe("Orca's tool relay", () => {
  it("adds the tool's saved headers and drops the bot's token on the way to its server", async () => {
    const tool = await upstream((_seen, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' })
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}')
    })
    const bot = await botWith(tool.url)
    const answer = await call(bot.address, {
      headers: {
        ...json,
        authorization: `Bearer ${bot.token}`,
        cookie: 'c=1',
        'mcp-method': 'tools/call',
        'mcp-name': 'search',
        'mcp-param-region': 'us-west1'
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"region":"us-west1"}}}'
    })
    expect(answer.status).toBe(200)
    expect(answer.headers['mcp-session-id']).toBe('s1')
    expect(answer.body).toContain('"result"')
    expect(tool.seen[0]?.headers['x-api-key']).toBe(SECRET)
    expect(tool.seen[0]?.headers['mcp-method']).toBe('tools/call')
    expect(tool.seen[0]?.headers['mcp-name']).toBe('search')
    expect(tool.seen[0]?.headers['mcp-param-region']).toBe('us-west1')
    expect(tool.seen[0]?.headers.authorization).toBeUndefined()
    expect(tool.seen[0]?.headers.cookie).toBeUndefined()
    expect(tool.seen[0]?.body).toContain('tools/call')
  })

  it('refuses a call without the token, with another bot’s token, or from a browser page', async () => {
    const tool = await upstream((_seen, res) => res.end('{}'))
    const scout = await botWith(tool.url, 'scout', 'cred-scout-1', 'scout-secret')
    const other = await botWith(tool.url, 'other', 'cred-other-1', 'other-secret')
    const noToken = await call(scout.address, { headers: json, body: '{}' })
    expect(noToken.status).toBe(401)
    expect(noToken.headers['www-authenticate']).toBeUndefined()
    // other's valid token on scout's real credential: its token names only its own folder.
    const stranger = await call(scout.address, {
      headers: { ...json, authorization: `Bearer ${other.token}` },
      body: '{}'
    })
    expect(stranger.status).toBe(404)
    // ...while each bot's own token still reaches its own credential and only its own value.
    expect(
      (
        await call(other.address, {
          headers: { ...json, authorization: `Bearer ${other.token}` },
          body: '{}'
        })
      ).status
    ).toBe(200)
    expect(tool.seen.map((seen) => seen.headers['x-api-key'])).toEqual(['other-secret'])
    tool.seen.length = 0
    const page = await call(scout.address, {
      headers: { ...json, authorization: `Bearer ${scout.token}`, origin: 'https://evil.example' },
      body: '{}'
    })
    expect(page.status).toBe(403)
    expect(tool.seen).toHaveLength(0)
  })

  it('refuses a token from before Orca restarted', async () => {
    const tool = await upstream((_seen, res) => res.end('{}'))
    const bot = await botWith(tool.url)
    relay.close()
    relay = new BotToolRelay((url, init) => fetch(url, init))
    const { origin } = await relay.grant('scout', { bot: bot.folder })
    const answer = await call(`${origin}/bot-tools/cred-notion/mcp`, {
      headers: { ...json, authorization: `Bearer ${bot.token}` },
      body: '{}'
    })
    expect(answer.status).toBe(401)
  })

  it('keeps two tools whose servers hand out the same session id apart', async () => {
    const a = await upstream((_seen, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' })
      res.end('{}')
    })
    const b = await upstream((_seen, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' })
      res.end('{}')
    })
    const botA = await botWith(a.url, 'scout', 'cred-a-0001')
    const botB = await botWith(b.url, 'other', 'cred-b-0001')
    const send = (bot: typeof botA, session?: string) =>
      call(bot.address, {
        headers: {
          ...json,
          authorization: `Bearer ${bot.token}`,
          ...(session ? { 'mcp-session-id': session } : {})
        },
        body: '{}'
      })
    await send(botA)
    await send(botB)
    expect((await send(botA, 'session-1')).status).toBe(200)
  })

  it('stops the upstream call when the agent goes away, and reads no further than the agent takes', async () => {
    // Far more than any socket and fetch buffers between the three hops can hold.
    const REPLY_BYTES = 128 * 1024 * 1024
    let written = 0
    let waitingToDrain = false
    let upstreamClosed = false
    const tool = await upstream((_seen, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.on('close', () => (upstreamClosed = true))
      const chunk = `data: ${'x'.repeat(256 * 1024)}\n\n`
      const pump = () => {
        while (written < REPLY_BYTES && !upstreamClosed) {
          written += chunk.length
          if (!res.write(chunk)) {
            waitingToDrain = true
            res.once('drain', () => {
              waitingToDrain = false
              pump()
            })
            return
          }
        }
      }
      pump()
    })
    const bot = await botWith(tool.url)
    const req = request(bot.address, {
      method: 'GET',
      headers: { accept: 'text/event-stream', authorization: `Bearer ${bot.token}` }
    })
    req.on('error', () => {})
    req.end()
    const response = await new Promise<IncomingMessage>((resolve) => req.on('response', resolve))
    response.pause()
    // The tool's server ends up stalled on the relay, which waits on the agent: what it has sent
    // stays flat across several checks while the agent reads nothing.
    let seen = -1
    let flatChecks = 0
    await vi.waitFor(
      () => {
        flatChecks = waitingToDrain && written === seen ? flatChecks + 1 : 0
        seen = written
        expect(flatChecks).toBeGreaterThanOrEqual(5)
      },
      { timeout: 20_000, interval: 100 }
    )
    // Stalled well before the end: the relay never read the reply ahead of the agent.
    expect(written).toBeLessThan(REPLY_BYTES)
    req.destroy()
    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
  })

  it('stops a deleted bot’s token', async () => {
    const tool = await upstream((_seen, res) => res.end('{}'))
    const bot = await botWith(tool.url)
    relay.revoke('scout')
    const answer = await call(bot.address, {
      headers: { ...json, authorization: `Bearer ${bot.token}` },
      body: '{}'
    })
    expect(answer.status).toBe(401)
  })

  it('lets a token reach only the folders its grant names, and the host’s names no bot', async () => {
    const tool = await upstream((_seen, res) => res.end('{}'))
    const hostFolder = toolsFolder(tool.url, 'cred-host-1')
    const botFolder = toolsFolder(tool.url, 'cred-bot-1')
    const host = await relay.grant(MCP_HOST_LIST_RELAY_OWNER, { host: hostFolder })
    const alone = await relay.grant('scout', { bot: botFolder })
    const reach = (token: string, path: string) =>
      call(`${host.origin}${path}`, {
        headers: { ...json, authorization: `Bearer ${token}` },
        body: '{}'
      }).then((answer) => answer.status)

    expect(relay.botOf(host.token)).toBeNull()
    expect(await reach(host.token, '/mcp-servers/cred-host-1/mcp')).toBe(200)
    expect(await reach(host.token, '/bot-tools/cred-bot-1/mcp')).toBe(404)
    expect(await reach(alone.token, '/mcp-servers/cred-host-1/mcp')).toBe(404)
    // A bot that takes the host list reaches both with its one token.
    const both = await relay.grant('scout', { bot: botFolder, host: hostFolder })
    expect(both.token).toBe(alone.token)
    expect(await reach(both.token, '/mcp-servers/cred-host-1/mcp')).toBe(200)
    expect(await reach(both.token, '/bot-tools/cred-bot-1/mcp')).toBe(200)
    expect(relay.botOf(both.token)).toBe('scout')
  })

  it('never follows a redirect with saved values, and passes a refusal on as 403', async () => {
    const redirecting = await upstream((_seen, res) => {
      res.writeHead(307, { location: 'https://evil.example/mcp' })
      res.end()
    })
    const bot = await botWith(redirecting.url)
    const moved = await call(bot.address, {
      headers: { ...json, authorization: `Bearer ${bot.token}` },
      body: '{}'
    })
    expect(moved.status).toBe(502)

    const refusing = await upstream((_seen, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="x"' })
      res.end('{}')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refused = await botWith(refusing.url, 'refused')
    const answer = await call(refused.address, {
      headers: { ...json, authorization: `Bearer ${refused.token}` },
      body: '{}'
    })
    expect(answer.status).toBe(403)
    expect(answer.headers['www-authenticate']).toBeUndefined()
    expect(relay.lastProblem(refused.folder, 'cred-notion')).toContain('refused')
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls)
    expect(logged).not.toContain(SECRET)
    expect(logged).not.toContain(refused.token)
  })

  it('streams an event stream as it arrives', async () => {
    let finish: () => void = () => {}
    const tool = await upstream((_seen, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      finish = () => res.end('data: last\n\n')
    })
    const bot = await botWith(tool.url)
    const first = await new Promise<string>((resolve, reject) => {
      const req = request(
        bot.address,
        {
          method: 'GET',
          headers: { accept: 'text/event-stream', authorization: `Bearer ${bot.token}` }
        },
        (res) => {
          res.once('data', (chunk) => {
            resolve(String(chunk))
            finish()
            res.resume()
          })
        }
      )
      req.on('error', reject)
      req.end()
    })
    expect(first).toContain('first')
  })

  it('makes the client start over when the tool’s upstream changed under its session', async () => {
    const tool = await upstream((_seen, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' })
      res.end('{}')
    })
    const bot = await botWith(tool.url)
    const headers = { ...json, authorization: `Bearer ${bot.token}` }
    await call(bot.address, { headers, body: '{}' })
    changeBotToolCredentials(
      bot.folder,
      new Map([['cred-notion', { url: tool.url, headers: { 'x-api-key': 'rotated' } }]])
    )
    const stale = await call(bot.address, {
      headers: { ...headers, 'mcp-session-id': 's1' },
      body: '{}'
    })
    expect(stale.status).toBe(404)
  })

  it('refuses a request body over the cap', async () => {
    const tool = await upstream((_seen, res) => res.end('{}'))
    const bot = await botWith(tool.url)
    const answer = await call(bot.address, {
      headers: { ...json, authorization: `Bearer ${bot.token}` },
      body: 'x'.repeat(16 * 1024 * 1024 + 1)
    })
    expect(answer.status).toBe(413)
    expect(tool.seen).toHaveLength(0)
  })
})

describe('a tool whose headers come from a source', () => {
  it('adds the source’s current headers, and refuses when the source has none', async () => {
    const tool = await upstream((_seen, res) => res.end('{}'))
    let key: string | null = 'hub-key-1'
    relay.close()
    relay = new BotToolRelay(
      (url, init) => fetch(url, init),
      botToolCredentialSource({ hub: () => (key ? { 'x-api-key': key } : null) })
    )
    const folder = mkdtempSync(join(tmpdir(), 'relay-bot-'))
    dirs.push(folder)
    changeBotToolCredentials(
      folder,
      new Map([['cred-hub-1', { url: tool.url, headers: {}, source: 'hub' }]])
    )
    writeToolsFile(folder, { 'cred-hub-1': tool.url })
    const { origin, token } = await relay.grant('scout', { bot: folder })
    const address = `${origin}/bot-tools/cred-hub-1/mcp`
    const headers = { ...json, authorization: `Bearer ${token}` }
    await call(address, { headers, body: '{}' })
    key = 'hub-key-2'
    await call(address, { headers, body: '{}' })
    expect(tool.seen.map((seen) => seen.headers['x-api-key'])).toEqual(['hub-key-1', 'hub-key-2'])
    key = null
    expect((await call(address, { headers, body: '{}' })).status).toBe(502)
  })
})
