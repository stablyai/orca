import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotToolSignInAttemptView } from '../../../shared/bot-tool-sign-in'
import {
  _resetSecretStoreForTests,
  setSecretStore
} from '../../../shared/secure-storage/secret-store'
import { useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { changeBotToolServers } from '../bot-tools-file'
import { setBotToolOAuthDeps, type BotToolOAuthKey } from './bot-tool-oauth'
import { botToolSignInState } from './bot-tool-oauth-tokens'
import { settleBotToolRevocations } from './bot-tool-oauth-revoke'
import {
  cancelBotToolSignInAttempt,
  finishBotToolSignInAttempt,
  startBotToolSignInAttempt,
  waitBotToolSignInAttempt
} from './bot-tool-sign-in-attempts'
import { FakeApp } from './bot-tool-oauth-fake-app.test-fixture'

const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

let app: FakeApp
let key: BotToolOAuthKey

beforeEach(async () => {
  useBotToolCredentialsRoot(tempDir('bot-tool-attempt-store-'))
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
})

afterEach(async () => {
  await settleBotToolRevocations()
  app.server.closeAllConnections()
  app.server.close()
  setBotToolOAuthDeps({})
  useBotToolCredentialsRoot(null)
  _resetSecretStoreForTests()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function waiting(view: BotToolSignInAttemptView) {
  if (view.state !== 'waiting') {
    throw new Error(`expected waiting, got ${view.state}`)
  }
  return view
}

/** The query the device's browser returns with after approving, as the device sends it. */
function returnedQuery(view: BotToolSignInAttemptView, state?: string): string {
  const { authorizationUrl } = waiting(view)
  const query = new URLSearchParams({
    code: app.approve(authorizationUrl),
    state: state ?? new URL(authorizationUrl).searchParams.get('state')!,
    iss: app.base
  })
  return `?${query}`
}

function get(url: URL): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sent = request(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    sent.on('error', reject)
    sent.end()
  })
}

describe('a sign-in the host runs for another device', () => {
  it('finishes once from the returned query, only for the device that started it', async () => {
    const started = waiting(await startBotToolSignInAttempt('phone', key, 'paste'))
    const redirect = new URL(started.redirectUri)
    expect(redirect.hostname).toBe('127.0.0.1')
    expect(redirect.pathname).toBe('/callback')

    // Another device, and a query from another sign-in, are refused and spend nothing.
    await expect(
      finishBotToolSignInAttempt('laptop', started.flowId, returnedQuery(started))
    ).rejects.toThrow('no longer active')
    await expect(
      finishBotToolSignInAttempt('phone', started.flowId, returnedQuery(started, 'forged'))
    ).rejects.toThrow('isn’t this sign-in’s return')
    const query = returnedQuery(started)
    await expect(
      finishBotToolSignInAttempt('phone', started.flowId, `${query}&code=duplicate`)
    ).rejects.toThrow('isn’t this sign-in’s return')

    const done = await finishBotToolSignInAttempt('phone', started.flowId, query)

    expect(done).toMatchObject({ state: 'done' })
    expect(botToolSignInState(key)).toEqual({ state: 'signed-in', limited: false })
    await expect(finishBotToolSignInAttempt('phone', started.flowId, query)).rejects.toThrow(
      'already used'
    )
    expect(app.hitsTo('/token')).toHaveLength(1)
    // A device whose finish reply was lost reads how it ended.
    expect(await waitBotToolSignInAttempt('phone', started.flowId, 0)).toMatchObject({
      state: 'done'
    })
  })

  it('lets the newest start win: the older device’s return is refused', async () => {
    const first = waiting(await startBotToolSignInAttempt('phone', key, 'paste'))
    const second = waiting(await startBotToolSignInAttempt('laptop', key, 'routed'))

    expect(await waitBotToolSignInAttempt('phone', first.flowId, first.revision)).toMatchObject({
      state: 'failed',
      code: 'superseded'
    })
    await expect(
      finishBotToolSignInAttempt('phone', first.flowId, returnedQuery(first))
    ).rejects.toThrow()
    expect(
      await finishBotToolSignInAttempt('laptop', second.flowId, returnedQuery(second))
    ).toMatchObject({ state: 'done' })
  })

  it('refuses a return after five minutes, however often it was polled', async () => {
    let clock = 1_800_000_000_000
    setBotToolOAuthDeps({ now: () => clock })
    const started = waiting(await startBotToolSignInAttempt('phone', key, 'paste'))
    await waitBotToolSignInAttempt('phone', started.flowId, 0)

    clock += 5 * 60_000 + 1
    const ended = await finishBotToolSignInAttempt('phone', started.flowId, returnedQuery(started))

    expect(ended).toMatchObject({ state: 'failed', code: 'expired' })
    expect(app.hitsTo('/token')).toHaveLength(0)
    expect(botToolSignInState(key)).toEqual({ state: 'signed-out' })
  })

  it('finishes from a routed page on the host’s own listener, Signed in only once stored', async () => {
    const started = waiting(await startBotToolSignInAttempt('laptop', key, 'routed'))
    const back = new URL(`${started.redirectUri}${returnedQuery(started, 'forged')}`)

    // A forged return gets a neutral page and spends nothing.
    expect((await get(back)).status).toBe(400)
    back.search = returnedQuery(started)
    const page = await get(back)

    expect(page.body.indexOf('Signed in')).toBeGreaterThan(page.body.indexOf('Finishing sign-in'))
    expect(await waitBotToolSignInAttempt('laptop', started.flowId, 0)).toMatchObject({
      state: 'done'
    })
    expect(botToolSignInState(key)).toEqual({ state: 'signed-in', limited: false })
  })

  it('registers again only when the return address changes; a paste keeps the last one', async () => {
    const first = waiting(await startBotToolSignInAttempt('laptop', key, 'routed'))
    await finishBotToolSignInAttempt('laptop', first.flowId, returnedQuery(first))
    expect(app.hitsTo('/register')).toHaveLength(1)

    const pasted = waiting(await startBotToolSignInAttempt('phone', key, 'paste'))
    expect(pasted.redirectUri).toBe(first.redirectUri)
    expect(app.hitsTo('/register')).toHaveLength(1)

    const moved = waiting(await startBotToolSignInAttempt('laptop', key, 'routed'))
    expect(moved.redirectUri).not.toBe(first.redirectUri)
    expect(app.hitsTo('/register')).toHaveLength(2)
  })

  it('says an app that can’t register Orca isn’t supported yet', async () => {
    const { registration_endpoint: _registration, ...noRegistration } = app.metadata
    app.metadata = noRegistration

    expect(await startBotToolSignInAttempt('phone', key, 'paste')).toMatchObject({
      state: 'failed',
      code: 'unsupported'
    })
    expect(botToolSignInState(key)).toEqual({ state: 'signed-out', problem: 'unsupported' })
  })

  it('ends when the tool is removed, and on cancel', async () => {
    const started = waiting(await startBotToolSignInAttempt('phone', key, 'paste'))
    await changeBotToolServers(key.folder, () => [])

    expect(await waitBotToolSignInAttempt('phone', started.flowId, started.revision)).toMatchObject(
      { state: 'failed', code: 'no-tool' }
    )

    await changeBotToolServers(
      key.folder,
      () => [{ name: 'app', url: app.url, credential: 'cred-0002' }],
      undefined,
      undefined,
      new Map([['cred-0002', { url: app.url, signIn: true as const }]])
    )
    const again = waiting(
      await startBotToolSignInAttempt('phone', { ...key, credentialId: 'cred-0002' }, 'paste')
    )
    expect(cancelBotToolSignInAttempt('phone', again.flowId)).toMatchObject({
      state: 'failed',
      code: 'cancelled'
    })
  })
})
