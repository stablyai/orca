// Sign-in and Graph calls against responses shaped like Microsoft's documented ones; no live tenant.
import { mkdtempSync, rmSync } from 'node:fs'
import type * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (actual) => ({
  ...(await actual<typeof os>()),
  homedir: () => home.dir
}))

const { _resetSecretStoreForTests, setSecretStore } =
  await import('../../shared/secure-storage/secret-store')
const { runTeamsDeviceSignIn } = await import('./teams-device-sign-in')
const { readTeamsAccount } = await import('./teams-credential-store')
const { teamsGraph } = await import('./teams-graph')
const { postTeamsMessage, readTeamsPlace } = await import('./teams-actions')

const TENANT = 'contoso.onmicrosoft.com'
const CLIENT = '11111111-2222-3333-4444-555555555555'
const TEAM = '2f1a7a5e-3b0c-4c8e-9f3e-6c1d2b7a9e10'
const CHANNEL = '19:a1b2c3d4e5f6@thread.tacv2'
const LOGIN = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`
const GRAPH = 'https://graph.microsoft.com/v1.0'
const THREAD = `${GRAPH}/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}/messages/1732550000000`

type Call = { url: string; form?: URLSearchParams; json?: unknown; auth?: string | null }

/** A fake Microsoft that answers each URL from a list, in order, and records what was sent. */
function recorded(answers: Record<string, Response[]>) {
  const calls: Call[] = []
  const http: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? init.body : undefined
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      auth: headers.get('authorization'),
      ...(headers.get('content-type')?.includes('form') ? { form: new URLSearchParams(body) } : {}),
      ...(headers.get('content-type')?.includes('json') ? { json: JSON.parse(body ?? 'null') } : {})
    })
    const next = answers[url]?.shift()
    if (!next) {
      throw new Error(`unrecorded request: ${url}`)
    }
    return next
  }
  return { http, calls }
}

const channel = () => {
  const controller = new AbortController()
  const prompts: unknown[] = []
  return {
    prompts,
    channel: {
      signal: controller.signal,
      stopped: () => null,
      onPrompt: (prompt: unknown) => prompts.push(prompt),
      nextCode: () => new Promise<never>(() => {})
    }
  }
}

const deviceCode = () =>
  Response.json({
    device_code: 'device-code',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://microsoft.com/devicelogin',
    expires_in: 900,
    interval: 5,
    message: 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin.'
  })
const pending = (error: string) =>
  Response.json(
    { error, error_description: `AADSTS70016: ${error}.\r\nTrace ID: x`, error_codes: [70016] },
    { status: 400 }
  )
const tokens = (
  access: string,
  scope = 'Chat.Read ChatMessage.Send ChannelMessage.Read.All ChannelMessage.Send Channel.ReadBasic.All Team.ReadBasic.All User.Read profile openid email'
) =>
  Response.json({
    token_type: 'Bearer',
    scope,
    expires_in: 4799,
    ext_expires_in: 4799,
    access_token: access,
    refresh_token: 'refresh-1'
  })
const me = () =>
  Response.json({
    '@odata.context': `${GRAPH}/$metadata#users(id,displayName,mail,userPrincipalName)/$entity`,
    id: 'user-ada',
    displayName: 'Ada Lovelace',
    mail: 'ada@contoso.com',
    userPrincipalName: 'ada@contoso.com'
  })

async function signIn(now: { at: number }, extra: Record<string, Response[]> = {}) {
  const fake = recorded({
    [`${LOGIN}/devicecode`]: [deviceCode()],
    [`${LOGIN}/token`]: [
      pending('authorization_pending'),
      pending('slow_down'),
      tokens('access-1'),
      ...(extra[`${LOGIN}/token`] ?? [])
    ],
    [`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`]: [me()],
    ...Object.fromEntries(Object.entries(extra).filter(([url]) => url !== `${LOGIN}/token`))
  })
  const waits: number[] = []
  const { channel: flow, prompts } = channel()
  const record = await runTeamsDeviceSignIn(
    {
      http: fake.http,
      now: () => now.at,
      sleep: async (ms) => {
        waits.push(ms)
        now.at += ms
      }
    },
    { tenantId: TENANT, clientId: CLIENT, channels: true },
    flow
  )
  return { record, fake, waits, prompts }
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), 'orca-teams-'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`sealed(${text})`, 'utf8'),
    decryptString: (cipher) => cipher.toString('utf8').replace(/^sealed\((.*)\)$/s, '$1'),
    describeProtectionGap: () => null
  })
})
afterEach(() => {
  _resetSecretStoreForTests()
  rmSync(home.dir, { recursive: true, force: true })
})

describe('Teams device sign-in', () => {
  it('polls through pending and slow_down, then keeps the grant on this host', async () => {
    const { record, fake, waits, prompts } = await signIn({ at: 1_000 })
    expect(prompts).toEqual([
      {
        verificationUri: 'https://microsoft.com/devicelogin',
        userCode: 'ABCD-EFGH',
        expiresAt: 901_000
      }
    ])
    expect(waits).toEqual([5_000, 5_000, 10_000])
    expect(fake.calls[0]?.form?.get('scope')).toBe(
      'offline_access User.Read Chat.Read ChatMessage.Send Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send'
    )
    // The token goes only to Microsoft Graph; the device code only to the tenant's login endpoint.
    expect(
      fake.calls.filter((call) => call.auth).map((call) => [call.url.split('?')[0], call.auth])
    ).toEqual([[`${GRAPH}/me`, 'Bearer access-1']])
    expect(record).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@contoso.com',
      userId: 'user-ada'
    })
    expect(await readTeamsAccount()).toEqual(record)
  })

  it('stops when the person declines, keeping nothing', async () => {
    const fake = recorded({
      [`${LOGIN}/devicecode`]: [deviceCode()],
      [`${LOGIN}/token`]: [pending('authorization_declined')]
    })
    const { channel: flow } = channel()
    await expect(
      runTeamsDeviceSignIn(
        { http: fake.http, now: () => 0, sleep: async () => {} },
        { tenantId: TENANT, clientId: CLIENT, channels: false },
        flow
      )
    ).rejects.toThrow('declined')
    expect(await readTeamsAccount()).toBeNull()
  })
})

describe('Teams Graph calls', () => {
  it('reads a thread with reply refs, and a reply ref answers on the thread root as escaped HTML', async () => {
    const now = { at: 1_000 }
    const { fake } = await signIn(now, {
      [`${GRAPH}/teams/${TEAM}?$select=id,displayName`]: [
        Response.json({ id: TEAM, displayName: 'Platform' })
      ],
      [`${GRAPH}/teams/${TEAM}/channels/${encodeURIComponent(CHANNEL)}?$select=id,displayName`]: [
        Response.json({ id: CHANNEL, displayName: 'Releases' })
      ],
      [THREAD]: [
        Response.json({
          id: '1732550000000',
          messageType: 'message',
          createdDateTime: '2026-11-25T16:00:00Z',
          from: { user: { displayName: 'Grace Hopper' } },
          body: { contentType: 'html', content: '<p>Ship <at id="0">Ada</at>?</p>' }
        })
      ],
      [`${THREAD}/replies?$top=20`]: [
        Response.json({
          value: [
            {
              id: '1732550099999',
              messageType: 'message',
              createdDateTime: '2026-11-25T16:05:00Z',
              from: { user: { displayName: 'Ada Lovelace' } },
              body: { contentType: 'html', content: '<p>Yes &amp; today</p>' }
            },
            {
              id: '1732550088888',
              messageType: 'systemEventMessage',
              createdDateTime: '2026-11-25T16:01:00Z'
            }
          ]
        })
      ],
      [`${THREAD}/replies`]: [
        Response.json(
          { id: '1732550123456', webUrl: 'https://teams.microsoft.com/l/message/x' },
          { status: 201 }
        )
      ]
    })
    const graph = teamsGraph({ http: fake.http, now: () => now.at })
    const thread = `teams:channel/${TEAM}/${CHANNEL}/1732550000000`
    const read = await readTeamsPlace(graph, thread)
    expect(read.place).toEqual({
      ref: thread,
      label: 'Thread in Platform › Releases',
      kind: 'thread'
    })
    expect(read.messages).toEqual([
      { ref: thread, from: 'Grace Hopper', at: '2026-11-25T16:00:00Z', text: 'Ship @Ada?' },
      {
        ref: `${thread}/1732550099999`,
        from: 'Ada Lovelace',
        at: '2026-11-25T16:05:00Z',
        text: 'Yes & today'
      }
    ])
    const posted = await postTeamsMessage(
      graph,
      read.messages[1]!.ref,
      '<b>done</b> & "shipped"\nnext'
    )
    expect(fake.calls.at(-1)).toMatchObject({
      url: `${THREAD}/replies`,
      json: {
        body: {
          contentType: 'html',
          content: '&lt;b&gt;done&lt;/b&gt; &amp; &quot;shipped&quot;<br>next'
        }
      }
    })
    expect(posted.ref).toBe(`${thread}/1732550123456`)
  })

  it('renews a refused token once, and never sends it to a next page outside Graph', async () => {
    const now = { at: 1_000 }
    const { fake } = await signIn(now, {
      [`${LOGIN}/token`]: [tokens('access-2')],
      [`${GRAPH}/me/joinedTeams`]: [
        Response.json(
          { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } },
          { status: 401 }
        ),
        Response.json({ value: [], '@odata.nextLink': 'https://evil.example/steal' })
      ]
    })
    const graph = teamsGraph({ http: fake.http, now: () => now.at })
    const first = await graph.get('/me/joinedTeams', z.object({ '@odata.nextLink': z.string() }))
    expect(
      fake.calls.slice(-3).map((call) => [call.url, call.auth ?? call.form?.get('grant_type')])
    ).toEqual([
      [`${GRAPH}/me/joinedTeams`, 'Bearer access-1'],
      [`${LOGIN}/token`, 'refresh_token'],
      [`${GRAPH}/me/joinedTeams`, 'Bearer access-2']
    ])
    const sent = fake.calls.length
    await expect(graph.get(first['@odata.nextLink'], z.unknown())).rejects.toThrow('outside Graph')
    expect(fake.calls.length).toBe(sent)
  })
})
