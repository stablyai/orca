import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changeBotToolCredentials } from '../bots/bot-tool-credentials'
import { botToolsPath, readBotToolServers } from '../bots/bot-tools-file'
import type { BotToolsCli } from '../bots/bot-tools-host'
import { botToolCredentialSource } from '../bots/tool-oauth/bot-tool-credential-source'
import { BotToolRelay, composioHeaderSource } from '../bots/tool-relay/bot-tool-relay'
import { ComposioBots } from './composio-bots'
import {
  cliFor,
  fakeComposio,
  SESSION,
  isolateComposioTestDirs
} from './composio-bots.test-fixtures'

isolateComposioTestDirs()

describe("a bot's Composio tool through Orca's relay", () => {
  let key: string | null
  let relay: BotToolRelay
  let forwarded: string[]
  beforeEach(() => {
    key = 'ak_one'
    forwarded = []
    relay = new BotToolRelay(
      async (url, init) => {
        forwarded.push(`${url} ${new Headers(init.headers).get('x-api-key')}`)
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
      botToolCredentialSource({ composio: composioHeaderSource(() => key) })
    )
  })
  afterEach(() => relay.close())

  const sessionUrl = (id: string) => `https://backend.composio.dev/tool_router/${id}/mcp`
  /** Two bots on one host, each with its own Composio user and session. */
  function twoBots(composio: ReturnType<typeof fakeComposio>) {
    const one = cliFor()
    const two = { ...cliFor(), botId: 'bot-2' }
    const clis: Record<string, BotToolsCli> = { 'bot-1': one, 'bot-2': two }
    const bots = new ComposioBots({
      keys: { read: () => key, save: (value) => (key = value), clear: () => (key = null) },
      cliOf: async (botId) => clis[botId]!,
      botIds: () => ['bot-1', 'bot-2'],
      onChange: () => {},
      api: composio.api
    })
    return { one, two, bots }
  }
  const credentialIdOf = async (cli: BotToolsCli) => {
    const [server] = await readBotToolServers(cli.folder)
    return server && 'credential' in server ? server.credential! : ''
  }
  const callAs = async (cli: BotToolsCli, owner: BotToolsCli) => {
    const { origin, token } = await relay.grant(cli.botId, cli.folder)
    const answer = await fetch(`${origin}/bot-tools/${await credentialIdOf(owner)}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}'
    })
    return answer.status
  }

  it("never lets a bot that edits its own tools file reach another bot's session", async () => {
    const composio = fakeComposio({
      'POST /tool_router/session': (init) => {
        const forBotOne = String(init?.body).includes('"orca-bot-bot-1"')
        return SESSION(forBotOne ? 'trs_one' : 'trs_two')
      },
      'PATCH /tool_router/session/*': (_init, url) => SESSION(url.pathname.split('/').pop()!)
    })
    const { one, two, bots } = twoBots(composio)
    await bots.ensureTool('bot-1')
    await bots.ensureTool('bot-2')
    // Bot one points its own file at bot two's session, then gets its tool fixed.
    const file = JSON.parse(readFileSync(botToolsPath(one.folder), 'utf8'))
    file.servers[0].url = sessionUrl('trs_two')
    writeFileSync(botToolsPath(one.folder), JSON.stringify(file))
    await bots.ensureTool('bot-1')

    expect(await callAs(one, one)).toBe(200)
    expect(forwarded).toEqual([`${sessionUrl('trs_one')} ak_one`])
    // Bot two's own credential stays out of reach of bot one's token.
    expect(await callAs(one, two)).toBe(404)
    expect(forwarded).toHaveLength(1)
  })

  it("keeps a running chat's relay address when Composio drops the session and Orca makes a new one", async () => {
    let dropped = false
    const composio = fakeComposio({
      'POST /tool_router/session': () => SESSION(dropped ? 'trs_new' : 'trs_old'),
      'PATCH /tool_router/session/*': () =>
        dropped ? { status: 404, body: { error: { message: 'gone' } } } : SESSION('trs_old')
    })
    const { one, bots } = twoBots(composio)
    await bots.ensureTool('bot-1')
    const before = await credentialIdOf(one)
    dropped = true
    await bots.ensureTool('bot-1')
    expect(await credentialIdOf(one)).toBe(before)
    expect(await callAs(one, one)).toBe(200)
    expect(forwarded).toEqual([`${sessionUrl('trs_new')} ak_one`])
  })

  it('never adds the owner key for a saved hub entry that names another address', async () => {
    const folder = cliFor().folder
    const attacker = 'https://attacker.example/hub'
    changeBotToolCredentials(
      folder,
      new Map([['cred-hub', { url: attacker, headers: {}, source: 'composio' }]])
    )
    mkdirSync(dirname(botToolsPath(folder)), { recursive: true })
    writeFileSync(
      botToolsPath(folder),
      JSON.stringify({ servers: [{ name: 'hub', url: attacker, credential: 'cred-hub' }] })
    )
    const { origin, token } = await relay.grant('bot-1', folder)
    const answer = await fetch(`${origin}/bot-tools/cred-hub/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}'
    })
    expect(answer.status).toBe(502)
    expect(forwarded).toEqual([])
  })
})
