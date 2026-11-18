import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetSecretStoreForTests,
  setSecretStore
} from '../../../shared/secure-storage/secret-store'
import { commitBotToolOAuth, useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { changeBotToolServers } from '../bot-tools-file'
import { onBotToolSignInChanged } from '../bot-tool-sign-in-changed'
import { setBotToolOAuthDeps, type BotToolOAuthKey } from './bot-tool-oauth'
import { botToolAccessToken, botToolSignInState } from './bot-tool-oauth-tokens'
import { settleBotToolRevocations, signOutBotTool } from './bot-tool-oauth-revoke'
import {
  botToolSignInProgress,
  connectBotToolSignIn,
  setBotToolSignInBrowser
} from './bot-tool-sign-in-flows'
import { FakeApp } from './bot-tool-oauth-fake-app.test-fixture'
import { connectOwnedBotTool } from './bot-tool-owned-sign-in'

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

let app: FakeApp
let key: BotToolOAuthKey
let opened: string[]

beforeEach(async () => {
  useBotToolCredentialsRoot(tempDir('bot-tool-flow-store-'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`sealed(${text})`, 'utf8'),
    decryptString: (cipher) => cipher.toString('utf8').replace(/^sealed\((.*)\)$/s, '$1'),
    describeProtectionGap: () => null
  })
  app = new FakeApp()
  await app.start()
  key = { folder: tempDir('bot-home-'), credentialId: 'cred-0001' }
  await changeBotToolServers(
    key.folder,
    () => [{ name: 'app', url: app.url, credential: key.credentialId }],
    undefined,
    undefined,
    new Map([[key.credentialId, { url: app.url, signIn: true as const }]])
  )
  opened = []
  setBotToolSignInBrowser(async (url) => {
    opened.push(url)
  })
})

afterEach(async () => {
  await settleBotToolRevocations()
  setBotToolSignInBrowser(null)
  app.server.closeAllConnections()
  app.server.close()
  setBotToolOAuthDeps({})
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Where the browser lands after approving, with the query the app sends back. */
function returnAddress(authorizationUrl: string, query: Record<string, string> = {}): URL {
  const authorize = new URL(authorizationUrl)
  const back = new URL(authorize.searchParams.get('redirect_uri')!)
  back.searchParams.set('code', app.approve(authorizationUrl))
  back.searchParams.set('state', authorize.searchParams.get('state')!)
  back.searchParams.set('iss', app.base)
  for (const [name, value] of Object.entries(query)) {
    back.searchParams.set(name, value)
  }
  return back
}

function get(
  url: URL,
  options: { method?: string; host?: string } = {}
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const sent = request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.host ? { host: options.host } : {}
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (body += chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers })
        )
      }
    )
    sent.on('error', reject)
    sent.end()
  })
}

describe('Connect for a tool Orca signs in to', () => {
  it('says Signed in only after the tokens are stored, and is spent once', async () => {
    const started = await connectBotToolSignIn(key)

    expect(opened).toHaveLength(1)
    expect(started.authorizationOrigin).toBe(app.base)
    expect(botToolSignInProgress(key)).toMatchObject({ state: 'waiting' })
    const back = returnAddress(opened[0]!)

    // Probes, another name for the listener and a forged state end nothing.
    expect((await get(back, { method: 'POST' })).status).toBe(405)
    expect((await get(back, { host: `evil.example:${back.port}` })).status).toBe(421)
    const forged = new URL(back)
    forged.searchParams.set('state', 'forged')
    expect((await get(forged)).status).toBe(400)
    expect(botToolSignInState(key)).toEqual({ state: 'signed-out' })

    const page = await get(back)

    expect(page.status).toBe(200)
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    expect(page.body).toContain('Finishing sign-in')
    expect(page.body.indexOf('Signed in')).toBeGreaterThan(page.body.indexOf('Finishing sign-in'))
    expect(page.body).not.toContain(back.searchParams.get('code')!)
    expect(botToolSignInState(key)).toEqual({ state: 'signed-in', limited: false })
    expect(botToolSignInProgress(key)).toEqual({ state: 'done' })
    await expect(get(back)).rejects.toThrow()
  })

  it('shows the failure, not Signed in, when the app refuses the code', async () => {
    await connectBotToolSignIn(key)
    app.tokenAnswer = async () => [400, { error: 'invalid_grant' }]

    const page = await get(returnAddress(opened[0]!))

    expect(page.body).toContain('Couldn’t sign in')
    expect(page.body).not.toContain('<h1>Signed in</h1>')
    expect(botToolSignInState(key)).toEqual({ state: 'signed-out' })
    expect(botToolSignInProgress(key)).toEqual({ state: 'failed', code: 'refused' })
  })

  it('ends the wait when the tool is removed', async () => {
    await connectBotToolSignIn(key)
    const back = returnAddress(opened[0]!)

    await changeBotToolServers(key.folder, () => [])

    expect(botToolSignInProgress(key)).toEqual({ state: 'idle' })
    await expect(get(back)).rejects.toThrow()
  })

  it('keeps why a sign-in could not start until one does, for every window and a restart', async () => {
    const { registration_endpoint: registration, ...noRegistration } = app.metadata
    app.metadata = noRegistration

    let announced = 0
    const stop = onBotToolSignInChanged(() => (announced += 1))

    await expect(connectBotToolSignIn(key)).rejects.toMatchObject({ code: 'unsupported' })

    stop()
    expect(botToolSignInState(key)).toEqual({ state: 'signed-out', problem: 'unsupported' })
    // Every window and phone re-reads the tools on this.
    expect(announced).toBe(1)
    app.metadata = { ...noRegistration, registration_endpoint: registration }
    await connectBotToolSignIn(key)
    expect(botToolSignInState(key)).toEqual({ state: 'signed-out' })
  })

  it('keeps a rotated refresh token when only why a sign-in failed changes', async () => {
    commitBotToolOAuth(key.folder, key.credentialId, (current) => ({
      url: current!.url,
      grant: current!.grant,
      record: {
        resource: app.url,
        issuer: app.base,
        client: { client_id: 'orca-client' },
        tokens: {
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          token_type: 'Bearer',
          expires_in: 0
        },
        obtainedAt: 0
      }
    }))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    app.tokenAnswer = async () => {
      entered.resolve()
      await release.promise
      return [
        200,
        {
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          token_type: 'Bearer',
          expires_in: 3600
        }
      ]
    }
    const refreshing = botToolAccessToken(key)
    await entered.promise
    const { registration_endpoint: _registration, ...noRegistration } = app.metadata
    app.metadata = noRegistration

    await expect(connectBotToolSignIn(key)).rejects.toMatchObject({ code: 'unsupported' })
    release.resolve()

    expect(await refreshing).toEqual({ token: 'rotated-access', grant: 0 })
  })

  it('does not put a cancelled sign-in’s failure back after a sign-out', async () => {
    const entered = Promise.withResolvers<void>()
    setBotToolOAuthDeps({
      fetch: async (_url, init) => {
        entered.resolve()
        const signal = init!.signal!
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason)
          } else {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          }
        })
        throw new Error('unreachable')
      }
    })
    const connecting = connectBotToolSignIn(key).catch(() => undefined)
    await entered.promise

    await signOutBotTool(key)
    await connecting
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(botToolSignInState(key)).toEqual({ state: 'signed-out' })
  })

  it('signs in nowhere on a host without a browser', async () => {
    setBotToolSignInBrowser(null)

    await expect(connectBotToolSignIn(key)).rejects.toMatchObject({ code: 'desktop-only' })
  })

  it('tells an older paired Orca to update instead of signing in another way', async () => {
    await expect(
      connectOwnedBotTool(key.folder, 'app', {
        caller: { kind: 'paired-device', deviceId: 'phone' }
      })
    ).rejects.toThrow('Update Orca on this device')
    expect(opened).toHaveLength(0)
  })
})
