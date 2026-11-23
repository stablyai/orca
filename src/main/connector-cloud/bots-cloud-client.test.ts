import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConnectorConnectRedeemRequestSchema,
  ConnectorConnectStartRequestSchema
} from '../../../cloud/packages/connector-contract/src/connect-messages'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import { botsCloudClient } from './bots-cloud-client'
import { ConnectorCloud } from './connector-cloud'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'

let userDataPath: string
let fake: FakeConnectorCloud
let account: string | null
let sent: { method: string; url: string; contentType: string | null; body: unknown }[]

function cloud(): ConnectorCloud {
  return new ConnectorCloud({
    userDataPath,
    origin: fake.origin,
    machine: fakeMachine(() => fakeSeam()),
    account: () => account,
    isFenced: () => false,
    mintFor: (who) => fake.mintFor(who),
    fetchImpl: async (input, init) => {
      sent.push({
        method: init?.method ?? 'GET',
        url: String(input),
        contentType: new Headers(init?.headers).get('content-type'),
        body: init?.body
      })
      return fake.fetch(input, init)
    }
  })
}

const botSlack = `${CONNECTOR_PATHS.bots}/bot-1/slack`

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-bots-cloud-'))
  fake = new FakeConnectorCloud()
  account = 'ada'
  sent = []
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('botsCloudClient', () => {
  it('hands the token to the grant route and reads back the workspace', async () => {
    fake.forced.set(CONNECTOR_PATHS.slackGrants, { status: 200, body: { teamId: 'T1' } })
    const result = await botsCloudClient(cloud()).saveSlackGrant('xoxe-1-secret')

    expect(result).toEqual({ ok: true, value: { teamId: 'T1' } })
    expect(fake.requestsTo(CONNECTOR_PATHS.slackGrants)).toEqual([
      {
        path: CONNECTOR_PATHS.slackGrants,
        body: { v: 1, refreshToken: 'xoxe-1-secret' },
        token: fake.minted[0].token
      }
    ])
  })

  it('reads state and members with bodiless GETs, and removes with a DELETE', async () => {
    fake.forced.set(botSlack, {
      status: 200,
      body: { state: 'created', teamId: 'T1', appId: 'A1' }
    })
    fake.forced.set(`${botSlack}/members`, {
      status: 200,
      body: { members: [{ id: 'U1', name: 'Jane Doe' }], complete: true }
    })
    const client = botsCloudClient(cloud())

    expect(await client.slackState('bot-1')).toEqual({
      ok: true,
      value: { state: 'created', teamId: 'T1', appId: 'A1' }
    })
    expect(await client.slackMembers('bot-1', 'jane doe&x')).toEqual({
      ok: true,
      value: { members: [{ id: 'U1', name: 'Jane Doe' }], complete: true }
    })
    expect(sent.map(({ method, contentType, body }) => ({ method, contentType, body }))).toEqual([
      { method: 'GET', contentType: null, body: undefined },
      { method: 'GET', contentType: null, body: undefined }
    ])
    expect(sent[1].url).toBe(`${fake.origin}${botSlack}/members?q=jane%20doe%26x`)

    fake.forced.set(botSlack, { status: 204 })
    expect(await client.removeSlackApp('bot-1')).toEqual({ ok: true, value: undefined })
    expect(sent[2].method).toBe('DELETE')
  })

  it('answers the cloud’s code, or the desktop’s when the cloud gave none', async () => {
    const client = botsCloudClient(cloud())
    fake.forced.set(`${botSlack}/apps`, { status: 409, body: { error: 'wrong_workspace' } })
    expect(await client.setUpSlackApp('bot-1', 'T2')).toEqual({
      ok: false,
      error: 'wrong_workspace'
    })

    fake.forced.set(botSlack, { status: 500 })
    expect(await client.slackState('bot-1')).toEqual({ ok: false, error: 'cloud_error' })

    fake.online = false
    expect(await client.slackState('bot-1')).toEqual({ ok: false, error: 'cloud_unreachable' })
  })

  it('refuses while signed out without calling the cloud', async () => {
    account = null
    expect(await botsCloudClient(cloud()).slackState('bot-1')).toEqual({
      ok: false,
      error: 'signed_out'
    })
    expect(sent).toHaveLength(0)
  })

  it('shares one connector token per account across calls', async () => {
    fake.forced.set(botSlack, { status: 200, body: { state: 'not_created' } })
    const client = botsCloudClient(cloud())
    await client.slackState('bot-1')
    await client.slackState('bot-1')
    expect(fake.minted).toHaveLength(1)
  })

  it('reads a cloud with Linear off as linear_off, and keeps every other Linear failure', async () => {
    const client = botsCloudClient(cloud())
    // A cloud without Linear has no such routes: a bare 404.
    fake.forced.set(`${CONNECTOR_PATHS.linear}/state`, { status: 404 })
    fake.forced.set(`${CONNECTOR_PATHS.linear}/connect`, { status: 404 })
    expect(await client.linearState()).toEqual({ ok: false, error: 'linear_off' })
    expect(await client.startConnect('linear', { loopback: null, switchAccount: false })).toEqual({
      ok: false,
      error: 'linear_off'
    })

    // A Linear route that exists says why it found nothing.
    fake.forced.set(`${CONNECTOR_PATHS.linear}/workspaces/w-1/members`, {
      status: 404,
      body: { error: 'not_linked' }
    })
    expect(await client.linearMembers('w-1', '')).toEqual({ ok: false, error: 'not_linked' })

    fake.forced.set(`${CONNECTOR_PATHS.linear}/state`, { status: 500 })
    expect(await client.linearState()).toEqual({ ok: false, error: 'cloud_error' })
    fake.forced.set(`${CONNECTOR_PATHS.linear}/connect/redeem`, {
      status: 409,
      body: { error: 'already_linked' }
    })
    expect(await client.redeemConnect('linear', 't'.repeat(43))).toEqual({
      ok: false,
      error: 'already_linked'
    })
  })

  it('starts and redeems a connect trip, unlinks, searches people and sets the default bot', async () => {
    const linear = CONNECTOR_PATHS.linear
    const authorizeUrl = 'https://connector.example/linear/connect/authorize?state=s'
    const linked = {
      identity: { userId: 'L-dana', name: 'Dana Lee', handle: 'dana', email: 'dana@acme.dev' },
      workspace: { id: 'w-1', name: 'Acme', urlKey: 'acme' },
      install: 'needs_admin'
    }
    fake.forced.set(`${linear}/connect`, { status: 200, body: { authorizeUrl } })
    fake.forced.set(`${linear}/connect/redeem`, { status: 200, body: linked })
    fake.forced.set(`${linear}/workspaces/w-1`, { status: 204 })
    fake.forced.set(`${linear}/workspaces/w-1/members`, {
      status: 200,
      body: { members: [{ id: 'L1', name: 'Bea' }], complete: true }
    })
    fake.forced.set(`${linear}/workspaces/w-1/default-bot`, { status: 204 })
    const client = botsCloudClient(cloud())

    expect(
      await client.startConnect('linear', {
        loopback: { port: 51234, nonce: 'n'.repeat(43) },
        switchAccount: true
      })
    ).toEqual({ ok: true, value: { authorizeUrl } })
    expect(await client.redeemConnect('linear', 'r'.repeat(43))).toEqual({
      ok: true,
      value: linked
    })
    expect(await client.unlinkLinear('w-1')).toEqual({ ok: true, value: undefined })
    expect(await client.linearMembers('w-1', 'be a')).toEqual({
      ok: true,
      value: { members: [{ id: 'L1', name: 'Bea' }], complete: true }
    })
    expect(await client.setLinearDefaultBot('w-1', 'bot-1')).toEqual({ ok: true, value: undefined })
    expect(sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      {
        method: 'POST',
        url: `${fake.origin}${linear}/connect`,
        body: JSON.stringify({
          v: 1,
          loopbackPort: 51234,
          loopbackNonce: 'n'.repeat(43),
          switchAccount: true
        })
      },
      {
        method: 'POST',
        url: `${fake.origin}${linear}/connect/redeem`,
        body: JSON.stringify({ v: 1, result: 'r'.repeat(43) })
      },
      { method: 'DELETE', url: `${fake.origin}${linear}/workspaces/w-1`, body: undefined },
      {
        method: 'GET',
        url: `${fake.origin}${linear}/workspaces/w-1/members?q=be%20a`,
        body: undefined
      },
      {
        method: 'PUT',
        url: `${fake.origin}${linear}/workspaces/w-1/default-bot`,
        body: '{"v":1,"botId":"bot-1"}'
      }
    ])
  })

  it('sends connect bodies the cloud contract accepts, and refuses ones it would not', async () => {
    const linear = CONNECTOR_PATHS.linear
    fake.forced.set(`${linear}/connect`, {
      status: 200,
      body: { authorizeUrl: 'https://connector.example/authorize' }
    })
    fake.forced.set(`${linear}/connect/redeem`, { status: 409, body: { error: 'wrong_account' } })
    const client = botsCloudClient(cloud())
    sent = []
    await client.startConnect('linear', {
      loopback: { port: 51234, nonce: 'n'.repeat(43) },
      switchAccount: false
    })
    await client.startConnect('linear', { loopback: null, switchAccount: true })
    expect(await client.redeemConnect('linear', 'r'.repeat(43))).toEqual({
      ok: false,
      error: 'wrong_account'
    })
    const bodies = sent.map(({ body }) => JSON.parse(String(body)))
    expect(ConnectorConnectStartRequestSchema.parse(bodies[0])).toEqual({
      v: 1,
      loopbackPort: 51234,
      loopbackNonce: 'n'.repeat(43)
    })
    // switchAccount is sent only as true, never as false.
    expect(ConnectorConnectStartRequestSchema.parse(bodies[1])).toEqual({
      v: 1,
      switchAccount: true
    })
    expect(ConnectorConnectRedeemRequestSchema.parse(bodies[2])).toEqual({
      v: 1,
      result: 'r'.repeat(43)
    })
    // A port the contract refuses never reaches the cloud.
    await expect(
      client.startConnect('linear', {
        loopback: { port: 80, nonce: 'n'.repeat(43) },
        switchAccount: false
      })
    ).rejects.toThrow()
    expect(sent).toHaveLength(3)
  })

  it('reads a cloud with GitHub off as github_off, and starts and redeems a connect trip', async () => {
    const github = CONNECTOR_PATHS.github
    const client = botsCloudClient(cloud())
    fake.forced.set(`${github}/state`, { status: 404 })
    expect(await client.githubState()).toEqual({ ok: false, error: 'github_off' })
    fake.forced.set(`${github}/connect/redeem`, { status: 409, body: { error: 'expired' } })
    expect(await client.redeemConnect('github', 'r'.repeat(43))).toEqual({
      ok: false,
      error: 'expired'
    })

    const authorizeUrl = 'https://github.com/login/oauth/authorize?client_id=c&state=s'
    fake.forced.set(`${github}/connect`, { status: 200, body: { authorizeUrl } })
    const linked = {
      identity: { userId: '42', name: '', handle: 'dana' },
      install: 'requested'
    }
    fake.forced.set(`${github}/connect/redeem`, { status: 200, body: linked })
    fake.forced.set(`${github}/link`, { status: 204 })
    fake.forced.set(`${github}/default-bot`, { status: 204 })
    const hubot = { members: [{ id: '9919', name: 'hubot' }], complete: true }
    fake.forced.set(`${github}/users`, { status: 200, body: hubot })
    sent = []
    // Without a loopback port the body names none, and the trip ends at "Open Orca".
    expect(await client.startConnect('github', { loopback: null, switchAccount: false })).toEqual({
      ok: true,
      value: { authorizeUrl }
    })
    expect(await client.redeemConnect('github', 'r'.repeat(43))).toEqual({
      ok: true,
      value: linked
    })
    expect(await client.unlinkGitHub()).toEqual({ ok: true, value: undefined })
    expect(await client.setGitHubDefaultBot(null)).toEqual({ ok: true, value: undefined })
    expect(await client.githubUsers('hu bot')).toEqual({ ok: true, value: hubot })
    expect(sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'POST', url: `${fake.origin}${github}/connect`, body: '{"v":1}' },
      {
        method: 'POST',
        url: `${fake.origin}${github}/connect/redeem`,
        body: JSON.stringify({ v: 1, result: 'r'.repeat(43) })
      },
      { method: 'DELETE', url: `${fake.origin}${github}/link`, body: undefined },
      { method: 'PUT', url: `${fake.origin}${github}/default-bot`, body: '{"v":1,"botId":null}' },
      { method: 'GET', url: `${fake.origin}${github}/users?q=hu%20bot`, body: undefined }
    ])
  })

  it('reads a cloud without access requests as none waiting, and passes on the owner check', async () => {
    fake.forced.set(CONNECTOR_PATHS.accessRequests, { status: 404, body: '' })
    expect(await botsCloudClient(cloud()).accessRequests()).toEqual({
      ok: true,
      value: { requests: [] }
    })
    const redeem = `${CONNECTOR_PATHS.accessRequests}/redeem`
    fake.forced.set(redeem, { status: 403, body: { error: 'not_owner' } })
    const token = 'c'.repeat(43)
    expect(await botsCloudClient(cloud()).redeemAccessRequest(token, ['bot-1'])).toEqual({
      ok: false,
      error: 'not_owner'
    })
    expect(fake.requestsTo(redeem)).toEqual([
      expect.objectContaining({ body: { v: 1, token, botIds: ['bot-1'] } })
    ])
  })
})
