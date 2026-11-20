import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { botToolsPath, readBotToolServers, writeBotToolServers } from '../bots/bot-tools-file'
import { readBotToolCredential } from '../bots/bot-tool-credentials'
import type { BotToolsCli } from '../bots/bot-tools-host'
import { ComposioCleanup } from './composio-cleanup'
import {
  ComposioKeyRejectedError,
  ComposioLimitError,
  ComposioNeedsOwnSignInError
} from './composio-api'
import { ComposioBots } from './composio-bots'
import {
  cliFor,
  fakeComposio,
  SESSION,
  isolateComposioTestDirs
} from './composio-bots.test-fixtures'

isolateComposioTestDirs()

describe('Composio apps for a bot', () => {
  let cli: BotToolsCli
  let key: string | null
  let changes: number
  beforeEach(() => {
    cli = cliFor()
    key = 'ak_one'
    changes = 0
  })

  const bots = (
    composio: ReturnType<typeof fakeComposio>,
    extra: Partial<ConstructorParameters<typeof ComposioBots>[0]> = {}
  ) =>
    new ComposioBots({
      keys: { read: () => key, save: (value) => (key = value), clear: () => (key = null) },
      cliOf: async () => cli,
      botIds: () => ['bot-1'],
      onChange: () => (changes += 1),
      api: composio.api,
      cleanup: new ComposioCleanup(
        join(mkdtempSync(join(tmpdir(), 'composio-cleanup-')), 'c.json')
      ),
      ...extra
    })

  /** The saved credential behind the bot's tool named `name`. */
  const credentialOf = async (name: string) => {
    const server = (await readBotToolServers(cli.folder)).find((entry) => entry.name === name)
    return server && 'credential' in server && server.credential
      ? readBotToolCredential(cli.folder, server.credential)
      : null
  }

  it('gives the bot its Composio tool once, the key added by the relay rather than saved', async () => {
    const composio = fakeComposio({
      'POST /tool_router/session': () => SESSION('trs_a'),
      'PATCH /tool_router/session/*': () => SESSION('trs_a')
    })
    const subject = bots(composio)
    expect(await subject.ensureTool('bot-1')).toBe('trs_a')
    expect(await subject.ensureTool('bot-1')).toBe('trs_a')
    expect(await readBotToolServers(cli.folder)).toEqual([
      {
        name: 'composio',
        url: 'https://backend.composio.dev/tool_router/trs_a/mcp',
        transport: 'http',
        credential: expect.any(String)
      }
    ])
    expect(readFileSync(botToolsPath(cli.folder), 'utf8')).not.toContain('ak_one')
    expect(await credentialOf('composio')).toEqual({
      url: 'https://backend.composio.dev/tool_router/trs_a/mcp',
      headers: {},
      source: 'composio'
    })
    const created = composio.calls.filter((call) => call.method === 'POST')
    expect(created).toEqual([
      {
        method: 'POST',
        path: '/tool_router/session',
        key: 'ak_one',
        body: {
          user_id: 'orca-bot-bot-1',
          manage_connections: { enable: false },
          workbench: { enable: false }
        }
      }
    ])
    expect(await subject.status('bot-1')).toEqual({ key: 'ok', limit: null, added: true })
    expect(subject.key()).toEqual({ key: 'ok', hint: '_one' })
  })

  it('moves the tool to a new session, keeping its name, when Composio dropped the old one', async () => {
    await writeBotToolServers(cli.folder, [
      {
        name: 'apps',
        url: 'https://backend.composio.dev/tool_router/trs_old/mcp',
        headers: { 'x-api-key': 'ak_one' }
      }
    ])
    const composio = fakeComposio({ 'POST /tool_router/session': () => SESSION('trs_new') })
    expect(await bots(composio).ensureTool('bot-1')).toBe('trs_new')
    expect(await readBotToolServers(cli.folder)).toEqual([
      expect.objectContaining({
        name: 'apps',
        url: 'https://backend.composio.dev/tool_router/trs_new/mcp'
      })
    ])
  })

  it('checks a new key before saving it; a key an older Orca saved in the tool is dropped', async () => {
    await writeBotToolServers(cli.folder, [
      {
        name: 'composio',
        url: 'https://backend.composio.dev/tool_router/trs_a/mcp',
        headers: { 'x-api-key': 'ak_one' }
      },
      { name: 'notion', url: 'https://mcp.notion.com/mcp', headers: { 'x-api-key': 'keep' } }
    ])
    const refused = fakeComposio({
      'GET /toolkits': () => ({ status: 401, body: { error: { message: 'bad' } } })
    })
    await expect(bots(refused).setKey('ak_bad')).rejects.toBeInstanceOf(ComposioKeyRejectedError)
    expect(key).toBe('ak_one')

    // A session only the old file names was never vouched for by the host, so the bot gets its own.
    const accepted = fakeComposio({
      'GET /toolkits': () => ({ body: { items: [] } }),
      'POST /tool_router/session': () => SESSION('trs_mine')
    })
    await bots(accepted).setKey(' ak_two ')
    expect(key).toBe('ak_two')
    expect(await credentialOf('composio')).toEqual({
      url: 'https://backend.composio.dev/tool_router/trs_mine/mcp',
      headers: {},
      source: 'composio'
    })
    expect((await credentialOf('notion'))?.headers).toEqual({ 'x-api-key': 'keep' })
    expect(readFileSync(botToolsPath(cli.folder), 'utf8')).not.toContain('ak_')
    expect(accepted.calls[0]).toMatchObject({ key: 'ak_two' })
  })

  it('gives a bot new sessions when the new key is from another Composio project', async () => {
    await writeBotToolServers(cli.folder, [
      {
        name: 'composio',
        url: 'https://backend.composio.dev/tool_router/trs_old/mcp',
        headers: { 'x-api-key': 'ak_one' }
      }
    ])
    // The new project doesn't know trs_old, so it answers 404 for it.
    const other = fakeComposio({
      'GET /toolkits': () => ({ body: { items: [] } }),
      'POST /tool_router/session': () => SESSION('trs_other')
    })
    const subject = bots(other)
    await subject.setKey('ak_other')
    expect(await readBotToolServers(cli.folder)).toEqual([
      {
        name: 'composio',
        url: 'https://backend.composio.dev/tool_router/trs_other/mcp',
        transport: 'http',
        credential: expect.any(String)
      }
    ])
    expect((await credentialOf('composio'))?.url).toBe(
      'https://backend.composio.dev/tool_router/trs_other/mcp'
    )
  })

  it('removes the key and the Composio tool from every bot', async () => {
    await writeBotToolServers(cli.folder, [
      {
        name: 'composio',
        url: 'https://backend.composio.dev/tool_router/trs_a/mcp',
        headers: { 'x-api-key': 'ak_one' }
      },
      { name: 'notion', url: 'https://mcp.notion.com/mcp' }
    ])
    cli.command = process.execPath
    cli.prefixArgs = ['-e', '0']
    const subject = bots(fakeComposio({}))
    await subject.removeKey()
    expect(key).toBeNull()
    expect(subject.keyState()).toBe('none')
    expect((await readBotToolServers(cli.folder)).map((server) => server.name)).toEqual(['notion'])
  })

  it('keeps the key and names the bot when its tool can’t be taken off', async () => {
    await writeBotToolServers(cli.folder, [
      { name: 'composio', url: 'https://backend.composio.dev/tool_router/trs_a/mcp' }
    ])
    const subject = bots(fakeComposio({}), {
      cliOf: async (botId) => (botId === 'bot-2' ? Promise.reject(new Error('locked')) : cli),
      botIds: () => ['bot-1', 'bot-2'],
      nameOf: (botId) => (botId === 'bot-2' ? 'Docs bot' : 'Inbox helper')
    })
    cli.command = process.execPath
    cli.prefixArgs = ['-e', '0']
    await expect(subject.removeKey()).rejects.toThrow('Docs bot')
    expect(key).toBe('ak_one')
  })

  it("picks another name when the owner's own config already has a composio tool", async () => {
    writeFileSync(
      join(cli.accountHome ?? '', '.claude.json'),
      JSON.stringify({ mcpServers: { composio: { url: 'https://mcp.composio.dev/x' } } })
    )
    const composio = fakeComposio({ 'POST /tool_router/session': () => SESSION('trs_a') })
    await bots(composio).ensureTool('bot-1')
    expect((await readBotToolServers(cli.folder)).map((server) => server.name)).toEqual([
      'composio-2'
    ])
  })

  it('makes sessions with Composio’s own connect tool and workbench off, and turns them off on an older one', async () => {
    const composio = fakeComposio({
      'POST /tool_router/session': () => SESSION('trs_a'),
      'PATCH /tool_router/session/trs_a': () => ({ body: {} })
    })
    const subject = bots(composio)
    await subject.ensureTool('bot-1')
    await subject.ensureTool('bot-1')
    const settings = { manage_connections: { enable: false }, workbench: { enable: false } }
    expect(composio.calls.find((call) => call.method === 'POST')?.body).toMatchObject(settings)
    expect(composio.calls.find((call) => call.method === 'PATCH')?.body).toEqual(settings)
  })

  it('makes one session when two Connects start at once', async () => {
    const composio = fakeComposio({
      'POST /tool_router/session': () => SESSION('trs_a'),
      'PATCH /tool_router/session/trs_a': () => SESSION('trs_a')
    })
    const subject = bots(composio)
    const ids = await Promise.all([subject.ensureTool('bot-1'), subject.ensureTool('bot-1')])
    expect(ids).toEqual(['trs_a', 'trs_a'])
    expect(composio.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    expect(await readBotToolServers(cli.folder)).toHaveLength(1)
  })

  it('reads apps by use and says how each signs in', async () => {
    const composio = fakeComposio({
      'GET /toolkits': (_init, url) => {
        expect(url.searchParams.get('sort_by')).toBe('usage')
        expect(url.searchParams.get('search')).toBe('mail')
        return {
          body: {
            items: [
              {
                slug: 'outlook',
                name: 'Outlook',
                auth_schemes: ['OAUTH2'],
                composio_managed_auth_schemes: ['OAUTH2'],
                meta: { description: 'Mail', logo: 'https://logos.composio.dev/api/outlook' }
              },
              { slug: 'tavily', name: 'Tavily', auth_schemes: ['API_KEY'] },
              { slug: 'shopify', name: 'Shopify', auth_schemes: ['OAUTH2'] },
              { slug: 'hackernews', name: 'Hacker News', no_auth: true },
              {
                slug: 'notion',
                name: 'Notion',
                composio_managed_auth_schemes: ['OAUTH2'],
                auth_config_details: [{ mode: 'OAUTH2' }, { mode: 'API_KEY' }]
              },
              { slug: 'twitter', name: 'Twitter', auth_config_details: [{ mode: 'OAUTH2' }] },
              {
                slug: 'posthog',
                name: 'PostHog',
                auth_schemes: [],
                auth_config_details: [{ mode: 'api_key' }]
              },
              {
                slug: 'reddit',
                name: 'Reddit',
                auth_config_details: [{ mode: 'NO_AUTH' }]
              },
              { slug: 'public-api', name: 'Public API', auth_schemes: ['no_auth'] }
            ],
            next_cursor: 'c2'
          }
        }
      }
    })
    const page = await bots(composio).apps({ search: ' mail ' })
    expect(page.nextCursor).toBe('c2')
    expect(page.apps.map((app) => [app.slug, app.signIn])).toEqual([
      ['outlook', 'composio'],
      ['tavily', 'key'],
      ['shopify', 'own'],
      ['hackernews', 'none'],
      ['notion', 'composio'],
      ['twitter', 'own'],
      ['posthog', 'key'],
      ['reddit', 'none'],
      ['public-api', 'none']
    ])
  })

  it('counts an app the owner set up in Composio’s Auth Configs as one Composio signs in to', async () => {
    const composio = fakeComposio({
      'GET /toolkits': () => ({
        body: { items: [{ slug: 'twitter', name: 'X', auth_schemes: ['OAUTH2'] }] }
      }),
      'GET /toolkits/posthog': () => ({
        body: { slug: 'posthog', name: 'PostHog', auth_config_details: [{ mode: 'API_KEY' }] }
      }),
      'GET /auth_configs': () => ({
        body: { items: [{ id: 'ac_x', status: 'ENABLED', toolkit: { slug: 'twitter' } }] }
      })
    })
    expect((await bots(composio).apps({})).apps[0]?.signIn).toBe('composio')
    expect((await bots(composio).app('posthog')).signIn).toBe('key')
  })

  it('connects an owner-set-up app by pointing the bot’s session at its auth config', async () => {
    let linked = false
    const composio = fakeComposio({
      'POST /tool_router/session': () => SESSION('trs_a'),
      'GET /tool_router/session/trs_a': () => ({
        body: { ...SESSION('trs_a').body, config: { auth_configs: { notion: 'ac_n' } } }
      }),
      'PATCH /tool_router/session/trs_a': () => {
        linked = true
        return { body: {} }
      },
      'POST /tool_router/session/trs_a/link': () =>
        linked
          ? {
              body: {
                redirect_url: 'https://connect.composio.dev/link/lk_x',
                connected_account_id: 'ca_x'
              }
            }
          : { status: 400, body: { error: { slug: 'ToolRouterV2_NoManagedAuth' } } },
      'GET /auth_configs': () => ({
        body: { items: [{ id: 'ac_x', status: 'ENABLED', toolkit: { slug: 'twitter' } }] }
      })
    })
    const subject = bots(composio)
    expect(await subject.connect('bot-1', 'twitter')).toEqual({
      url: 'https://connect.composio.dev/link/lk_x'
    })
    expect(composio.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      auth_configs: { notion: 'ac_n', twitter: 'ac_x' }
    })
    subject.cancelConnect('bot-1', 'twitter')
  })

  it('notes a refused key for every client, and clears it once Composio answers again', async () => {
    let status = 401
    const composio = fakeComposio({
      'GET /toolkits': () => ({ status, body: status === 200 ? { items: [] } : {} })
    })
    const subject = bots(composio)
    await expect(subject.apps({})).rejects.toBeInstanceOf(ComposioKeyRejectedError)
    expect(subject.keyState()).toBe('rejected')
    status = 200
    await subject.apps({})
    expect(subject.keyState()).toBe('ok')
    expect(changes).toBe(2)
  })

  it('waits on a Connect until the sign-in is active, then reports it', async () => {
    vi.useFakeTimers()
    let account: Record<string, unknown> = {
      id: 'ca_1',
      toolkit: { slug: 'notion' },
      status: 'INITIATED'
    }
    const composio = fakeComposio({
      'POST /tool_router/session': () => SESSION('trs_a'),
      'POST /tool_router/session/trs_a/link': () => ({
        body: {
          redirect_url: 'https://connect.composio.dev/link/lk_1',
          connected_account_id: 'ca_1'
        }
      }),
      'GET /connected_accounts/ca_1': () => ({ body: account }),
      'GET /connected_accounts': () => ({ body: { items: [account] } }),
      'GET /toolkits/notion': () => ({ body: { slug: 'notion', name: 'Notion' } })
    })
    const ended = vi.fn()
    const subject = bots(composio, { onConnectEnded: ended })
    expect(await subject.connect('bot-1', 'notion')).toEqual({
      url: 'https://connect.composio.dev/link/lk_1'
    })
    expect((await subject.connections('bot-1')).pending).toEqual([
      expect.objectContaining({ app: 'notion', url: 'https://connect.composio.dev/link/lk_1' })
    ])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ended).not.toHaveBeenCalled()
    account = {
      ...account,
      status: 'ACTIVE',
      state: { val: { displayName: 'dana@acme.com' } }
    }
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ended).toHaveBeenCalledWith(
      'bot-1',
      'notion',
      {
        id: 'ca_1',
        app: 'notion',
        name: 'notion',
        status: 'active',
        label: 'dana@acme.com'
      },
      null
    )
    expect(await subject.connections('bot-1')).toEqual({
      connections: [
        { id: 'ca_1', app: 'notion', name: 'Notion', status: 'active', label: 'dana@acme.com' }
      ],
      pending: []
    })
  })

  it('leaves out links nobody finished and Composio itself', async () => {
    const composio = fakeComposio({
      'GET /connected_accounts': () => ({
        body: {
          items: [
            {
              id: 'ca_1',
              toolkit: { slug: 'outlook' },
              status: 'EXPIRED',
              status_reason: 'Connection expired before authorization was started'
            },
            { id: 'ca_2', toolkit: { slug: 'notion' }, status: 'EXPIRED' },
            { id: 'ca_3', toolkit: { slug: 'jira' }, status: 'INITIATED' }
          ]
        }
      }),
      'GET /toolkits/notion': () => ({ body: { slug: 'notion', name: 'Notion' } }),
      'GET /toolkits': () => ({
        body: { items: [{ slug: 'composio', name: 'Composio', no_auth: true }] }
      })
    })
    const subject = bots(composio)
    expect((await subject.connections('bot-1')).connections).toEqual([
      { id: 'ca_2', app: 'notion', name: 'Notion', status: 'expired', label: null }
    ])
    expect((await subject.apps({})).apps).toEqual([])
  })

  it("a Reconnect's new sign-in replaces the app's old one", async () => {
    vi.useFakeTimers()
    const accounts = [
      { id: 'ca_old', toolkit: { slug: 'notion' }, status: 'EXPIRED' },
      { id: 'ca_new', toolkit: { slug: 'notion' }, status: 'ACTIVE' },
      { id: 'ca_other', toolkit: { slug: 'jira' }, status: 'ACTIVE' }
    ]
    const composio = fakeComposio({
      'POST /tool_router/session': () => SESSION('trs_a'),
      'POST /tool_router/session/trs_a/link': () => ({
        body: {
          redirect_url: 'https://connect.composio.dev/link/lk_2',
          connected_account_id: 'ca_new'
        }
      }),
      'GET /connected_accounts/ca_new': () => ({ body: accounts[1] }),
      'GET /connected_accounts': () => ({ body: { items: accounts } }),
      'DELETE /connected_accounts/ca_old': () => ({ body: { success: true } })
    })
    await bots(composio).connect('bot-1', 'notion')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(
      composio.calls.filter((call) => call.method === 'DELETE').map((call) => call.path)
    ).toEqual(['/connected_accounts/ca_old'])
  })

  it('stops waiting after 10 minutes and reports no sign-in', async () => {
    vi.useFakeTimers()
    const composio = fakeComposio({
      'POST /tool_router/session': () => SESSION('trs_a'),
      'POST /tool_router/session/trs_a/link': () => ({
        body: {
          redirect_url: 'https://connect.composio.dev/link/lk_1',
          connected_account_id: 'ca_1'
        }
      }),
      'GET /connected_accounts/ca_1': () => ({
        body: { id: 'ca_1', toolkit: { slug: 'notion' }, status: 'INITIATED' }
      })
    })
    const ended = vi.fn()
    const subject = bots(composio, { onConnectEnded: ended })
    await subject.connect('bot-1', 'notion')
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(ended).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(ended).toHaveBeenCalledWith('bot-1', 'notion', null, null)
  })

  it('a Cancel or a second Connect mid-wait replaces the first wait', async () => {
    vi.useFakeTimers()
    let link = 0
    const composio = fakeComposio({
      'POST /tool_router/session': () => SESSION('trs_a'),
      'PATCH /tool_router/session/trs_a': () => SESSION('trs_a'),
      'POST /tool_router/session/trs_a/link': () => {
        link += 1
        return {
          body: {
            redirect_url: `https://connect.composio.dev/link/lk_${link}`,
            connected_account_id: `ca_${link}`
          }
        }
      },
      'GET /connected_accounts/*': () => ({
        body: { id: 'ca_2', toolkit: { slug: 'notion' }, status: 'ACTIVE' }
      }),
      'GET /connected_accounts': () => ({ body: { items: [] } })
    })
    const ended = vi.fn()
    const subject = bots(composio, { onConnectEnded: ended })
    await subject.connect('bot-1', 'notion')
    await subject.connect('bot-1', 'notion')
    expect((await subject.connections('bot-1')).pending).toEqual([
      expect.objectContaining({ url: 'https://connect.composio.dev/link/lk_2' })
    ])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ended).toHaveBeenCalledTimes(1)
    const polled = composio.calls.filter((call) => call.path.startsWith('/connected_accounts/ca_'))
    expect(polled.map((call) => call.path)).toEqual(['/connected_accounts/ca_2'])

    await subject.connect('bot-1', 'jira')
    subject.cancelConnect('bot-1', 'jira')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('signs a deleted bot out of its apps and deletes its triggers once it is gone', async () => {
    const composio = fakeComposio({
      // Two pages: every one is cleaned up.
      'GET /trigger_instances/active': (_init, url) =>
        url.searchParams.get('cursor')
          ? { body: { items: [{ id: 'ti_2', trigger_name: 'OUTLOOK_MESSAGE_TRIGGER' }] } }
          : {
              body: {
                items: [{ id: 'ti_1', trigger_name: 'OUTLOOK_MESSAGE_TRIGGER' }],
                next_cursor: 'c2'
              }
            },
      'DELETE /trigger_instances/manage/*': () => ({ body: {} }),
      'GET /connected_accounts': () => ({
        body: { items: [{ id: 'ca_1', toolkit: { slug: 'notion' }, status: 'ACTIVE' }] }
      }),
      'DELETE /connected_accounts/ca_1': () => ({ body: { success: true } })
    })
    let live = true
    const subject = bots(composio, { botExists: () => live })
    await subject.willDelete('bot-1')
    // A delete that failed leaves the bot, and its sign-ins, in place.
    await subject.forget('bot-1')
    expect(composio.calls.filter((call) => call.method === 'DELETE')).toEqual([])
    live = false
    await expect(subject.forget('bot-1')).resolves.toBeUndefined()
    const deletes = composio.calls.filter((call) => call.method === 'DELETE')
    expect(deletes.map((c) => c.path)).toEqual([
      '/trigger_instances/manage/ti_1',
      '/trigger_instances/manage/ti_2',
      '/connected_accounts/ca_1'
    ])
  })

  // Project A answers to ak_one and its regenerated ak_one_new; project B to ak_b.
  const twoProjects = () => {
    const deleted: string[] = []
    const inA = (init: RequestInit | undefined) =>
      new Headers(init?.headers).get('x-api-key')?.startsWith('ak_one') ?? false
    const composio = fakeComposio({
      'GET /toolkits': () => ({ body: { items: [] } }),
      'GET /trigger_instances/active': () => ({ body: { items: [] } }),
      'PATCH /tool_router/session/trs_a': (init) =>
        inA(init) ? { body: {} } : { status: 404, body: { error: { message: 'gone' } } },
      'GET /connected_accounts': (init) => ({
        body: {
          items:
            inA(init) && !deleted.includes('ca_1')
              ? [{ id: 'ca_1', toolkit: { slug: 'notion' }, status: 'ACTIVE' }]
              : []
        }
      }),
      'DELETE /connected_accounts/ca_1': () => {
        deleted.push('ca_1')
        return { body: {} }
      }
    })
    return { composio, deleted }
  }

  it('keeps a deleted bot listed after a switch to another project, and cleans it up back home', async () => {
    const { composio, deleted } = twoProjects()
    const cleanup = new ComposioCleanup(join(mkdtempSync(join(tmpdir(), 'composio-')), 'c.json'))
    const subject = bots(composio, { cleanup, botExists: () => false })
    await subject.willDelete('bot-1')
    key = null
    await subject.forget('bot-1')
    expect(cleanup.pending()).toEqual([{ botId: 'bot-1', project: expect.any(String) }])
    await subject.setKey('ak_b')
    await subject.drainCleanup()
    expect(deleted).toEqual([])
    expect(cleanup.pending()).toHaveLength(1)
    await subject.setKey('ak_one')
    await vi.waitFor(() => expect(cleanup.pending()).toEqual([]))
    expect(deleted).toEqual(['ca_1'])
  })

  it('carries a deleted bot’s cleanup over to a regenerated key of the same project', async () => {
    await writeBotToolServers(cli.folder, [
      {
        name: 'composio',
        url: 'https://backend.composio.dev/tool_router/trs_a/mcp',
        headers: { 'x-api-key': 'ak_one' }
      }
    ])
    const { composio, deleted } = twoProjects()
    const cleanup = new ComposioCleanup(join(mkdtempSync(join(tmpdir(), 'composio-')), 'c.json'))
    const rekeyed = vi.fn()
    const subject = bots(composio, {
      cleanup,
      botExists: (botId) => botId === 'bot-1',
      onProjectRekeyed: rekeyed
    })
    cleanup.add({ botId: 'gone', project: subject.project() })
    // The old key is refused now, as after regenerating it in Composio.
    key = 'ak_one'
    await subject.setKey('ak_one_new')
    expect(rekeyed).toHaveBeenCalledWith(expect.any(String), subject.project())
    await vi.waitFor(() => expect(cleanup.pending()).toEqual([]))
    expect(deleted).toEqual(['ca_1'])
  })

  it.each([
    ['refusal', 401],
    ['plan limit', 429]
  ])('a replaced key’s late %s leaves the new key working', async (_kind, status) => {
    let answerOld = () => {}
    const composio = fakeComposio({
      'GET /toolkits': () => ({ body: { items: [] } }),
      'GET /connected_accounts': () => ({ body: { items: [] } })
    })
    const subject = bots(composio, {
      api: (k) => {
        const real = composio.api(k)
        return k !== 'ak_one'
          ? real
          : Object.assign(Object.create(real), {
              connections: () =>
                new Promise((_resolve, reject) => {
                  answerOld = () =>
                    reject(
                      status === 401
                        ? new ComposioKeyRejectedError()
                        : new ComposioLimitError(null, 'Monthly usage limit reached')
                    )
                })
            })
      }
    })
    const old = subject.connections('bot-1')
    await subject.setKey('ak_two')
    await subject.connections('bot-1')
    answerOld()
    await expect(old).rejects.toThrow()
    expect(subject.keyState()).toBe('ok')
    expect((await subject.status('bot-1')).limit).toBeNull()
    await subject.connections('bot-1')
    expect(composio.calls.filter((call) => call.path === '/connected_accounts')).toHaveLength(2)
  })

  it('a call that started before a limit was noted doesn’t lift it', async () => {
    let answerEarly = () => {}
    const composio = fakeComposio({
      'GET /toolkits': () => ({ body: { items: [] } }),
      'GET /connected_accounts': () => ({ status: 429, body: { error: { message: 'slow down' } } })
    })
    const api = composio.api
    const subject = bots(composio, {
      api: (k) => {
        const real = api(k)
        return Object.assign(Object.create(real), {
          apps: () =>
            new Promise((resolve) => {
              answerEarly = () => resolve({ apps: [], nextCursor: null })
            })
        })
      }
    })
    const early = subject.apps({})
    await expect(subject.connections('bot-1')).rejects.toThrow('limiting')
    answerEarly()
    await early
    expect((await subject.status('bot-1')).limit).toEqual({ retryAt: expect.any(Number) })
    await expect(subject.connections('bot-1')).rejects.toThrow('limiting')
    expect(composio.calls.filter((call) => call.path === '/connected_accounts')).toHaveLength(1)
  })

  it('tells clients of a limit once and calls no more until it lifts or the owner checks', async () => {
    let status = 429
    const composio = fakeComposio({
      'GET /toolkits': () =>
        status === 429
          ? { status, body: { error: { message: 'Monthly usage limit reached' } } }
          : { body: { items: [] } }
    })
    const subject = bots(composio)
    for (let read = 0; read < 3; read += 1) {
      await expect(subject.apps({})).rejects.toThrow('plan limit')
    }
    expect(composio.calls).toHaveLength(1)
    expect(changes).toBe(1)
    expect((await subject.status('bot-1')).limit).toEqual({ retryAt: null })
    await expect(subject.checkLimit()).rejects.toThrow('plan limit')
    expect(changes).toBe(1)
    status = 200
    await subject.checkLimit()
    expect(changes).toBe(2)
    expect((await subject.status('bot-1')).limit).toBeNull()
    await subject.apps({})
    expect(composio.calls).toHaveLength(4)
  })

  it('waits out a burst limit, then calls again on its own', async () => {
    vi.useFakeTimers()
    let status = 429
    const composio = fakeComposio({
      'GET /toolkits': () =>
        status === 429
          ? { status, body: { error: { message: 'slow down' } } }
          : { body: { items: [] } }
    })
    const subject = bots(composio)
    await expect(subject.apps({})).rejects.toThrow('limiting')
    await expect(subject.apps({})).rejects.toThrow('limiting')
    expect(composio.calls).toHaveLength(1)
    status = 200
    vi.advanceTimersByTime(60_000)
    await subject.apps({})
    expect(composio.calls).toHaveLength(2)
    expect((await subject.status('bot-1')).limit).toBeNull()
  })

  it("says when an app needs the owner's own sign-in in Composio", async () => {
    const composio = fakeComposio({
      'POST /tool_router/session': () => SESSION('trs_a'),
      'POST /tool_router/session/trs_a/link': () => ({
        status: 400,
        body: { error: { slug: 'ToolRouterV2_NoManagedAuth', message: 'no auth' } }
      })
    })
    await expect(bots(composio).connect('bot-1', 'twitter')).rejects.toBeInstanceOf(
      ComposioNeedsOwnSignInError
    )
  })

  it("disconnects only the bot's own sign-ins", async () => {
    const composio = fakeComposio({
      'GET /connected_accounts': () => ({
        body: { items: [{ id: 'ca_1', toolkit: { slug: 'notion' }, status: 'ACTIVE' }] }
      }),
      'DELETE /connected_accounts/ca_1': () => ({ body: { success: true } })
    })
    const subject = bots(composio)
    await expect(subject.disconnect('bot-1', 'ca_other')).rejects.toThrow('no such app sign-in')
    await subject.disconnect('bot-1', 'ca_1')
    expect(composio.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1)
  })

  it('removes the tool from the bot but leaves its sign-ins at Composio', async () => {
    await writeBotToolServers(cli.folder, [
      {
        name: 'composio',
        url: 'https://backend.composio.dev/tool_router/trs_a/mcp',
        headers: { 'x-api-key': 'ak_one' }
      }
    ])
    // A CLI that can't run: removing still drops the file entry.
    cli.command = process.execPath
    cli.prefixArgs = ['-e', '0']
    const composio = fakeComposio({})
    await bots(composio).removeFromBot('bot-1')
    expect(await readBotToolServers(cli.folder)).toEqual([])
    expect(composio.calls).toEqual([])
  })
})
