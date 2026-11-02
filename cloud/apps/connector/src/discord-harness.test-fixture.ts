import { generateKeyPairSync, sign } from 'node:crypto'
import {
  CONNECTOR_PATHS,
  ConnectorPollResponseSchema,
  type ConnectorProject
} from '@orca-cloud/connector-contract'
import { expect } from 'vitest'
import { createConnectorHarness } from './connector-server-harness.test-fixture.js'
import type { DiscordConfig } from './discord-config.js'
import type { DiscordGatewayMessage } from './discord-gateway-session.js'
import { runDiscordOperator } from './discord-operator.js'
import type { DiscordResult, DiscordRoute } from './discord-rest.js'
import { decodeDiscordPublicKey } from './discord-signature.js'

export const GUILD = '1100000000000000000'
export const CHANNEL = '1000000000000000000'
export const BOT = '1200000000000000000'
export const OWNER = '900000000000000001'
export const TEAMMATE = '900000000000000002'
export const MENTION = '1300000000000000100'

type Call = { route: DiscordRoute; token: string }

// Stands in for the REST API behind the post sender and history reader: records each call and
// answers with queued results by method and path prefix, else a plain success with a new id.
function fakeDiscord() {
  const calls: Call[] = []
  const queued: { method: string; path: string; result: DiscordResult }[] = []
  let id = 0
  const api = async (token: string, route: DiscordRoute): Promise<DiscordResult> => {
    calls.push({ token, route })
    const index = queued.findIndex(
      (entry) => entry.method === route.method && route.path.startsWith(entry.path)
    )
    const [answer] = index === -1 ? [] : queued.splice(index, 1)
    if (answer) {
      return answer.result
    }
    if (route.path === '/users/@me') {
      return { kind: 'ok', body: { id: BOT } }
    }
    if (route.method === 'GET') {
      return route.path.includes('?')
        ? { kind: 'ok', body: { items: [] } }
        : { kind: 'failed', status: 404, error: '10008' }
    }
    return { kind: 'ok', body: { id: `1400000000000000${String(++id).padStart(3, '0')}` } }
  }
  return {
    api,
    respond: (method: string, path: string, ...results: DiscordResult[]) => {
      queued.push(...results.map((result) => ({ method, path, result })))
    },
    take: () => calls.splice(0).map((call) => call.route)
  }
}

export function project(name: string, placeId = `pl_${name}`): ConnectorProject {
  return { placeId, name, kind: 'git', where: { kind: 'local' } }
}

export async function createDiscordHarness(discord: Partial<DiscordConfig> = {}) {
  const fake = fakeDiscord()
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const hex = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url').toString('hex')
  const harness = await createConnectorHarness(
    {
      discord: {
        publicKey: decodeDiscordPublicKey(hex),
        botToken: 'bot-token',
        guildIds: new Set([GUILD]),
        paused: false,
        ...discord
      }
    },
    { discordApi: fake.api }
  )
  const edge = harness.runtime.discord
  if (!edge) {
    throw new Error('Discord edge not configured')
  }
  const operator = (...argv: string[]) =>
    runDiscordOperator(argv, { database: harness.database, now: harness.now })

  // One gateway message, routed as the worker routes it.
  const message = (fields: Partial<DiscordGatewayMessage> & { messageId: string; text: string }) =>
    harness.database.transaction((transaction) =>
      edge.routeIn(transaction, harness.runtime.core, {
        guildId: GUILD,
        channelId: CHANNEL,
        userId: OWNER,
        userName: 'Owner',
        mentioned: false,
        ...fields
      })
    )

  // An interaction, signed as Discord signs them.
  const interaction = async (payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload)
    const timestamp = String(Math.floor(harness.now() / 1000))
    const response = await harness.request('/discord/interactions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature-timestamp': timestamp,
        'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), privateKey).toString('hex')
      },
      body
    })
    return { status: response.status, body: await response.json() }
  }

  // A button press.
  const press = (fields: {
    user?: string
    messageId: string
    customId: string
    channelId: string
  }) =>
    interaction({
      id: '1500000000000000001',
      application_id: BOT,
      type: 3,
      token: 'interaction-token',
      guild_id: GUILD,
      channel_id: fields.channelId,
      member: { user: { id: fields.user ?? OWNER, username: 'someone' } },
      data: { custom_id: fields.customId, component_type: 2 },
      message: { id: fields.messageId }
    })

  async function machineWith(account: string, projects: ConnectorProject[]) {
    const machine = await harness.machine(account)
    const response = await machine.call(
      CONNECTOR_PATHS.hello,
      {
        v: 1,
        contract: 1,
        hostName: 'build-box',
        platform: 'darwin',
        runtime: 'desktop',
        orcaVersion: '1.4.230',
        agents: ['claude'],
        promptKinds: ['approval'],
        features: ['answer', 'cancel', 'reply'],
        sources: ['discord'],
        projects
      },
      'PUT'
    )
    expect(response.status).toBe(200)
    return machine
  }

  const posts = async () =>
    await harness.database.query(
      `SELECT post_id, kind, body, state, message_ref FROM connector_posts
       WHERE source = 'discord' ORDER BY post_id`
    )

  return {
    ...harness,
    edge,
    fake,
    operator,
    message,
    interaction,
    press,
    machineWith,
    posts,
    // Each container sends one post at a time, so a few passes empty the queue.
    drain: async () => {
      for (let pass = 0; pass < 5; pass++) {
        await harness.runtime.core.sendDue()
      }
    }
  }
}

export const EXTERNAL_ID = `${GUILD}:${CHANNEL}:${MENTION}:${OWNER}`
export const conversation = { source: 'discord' as const, externalId: EXTERNAL_ID }
export const TURN = 1_800_000_001_000

// A linked owner's top-level mention, its start handed to their machine.
export async function startedThread() {
  const harness = await createDiscordHarness()
  await harness.operator(
    'link',
    '--guild',
    GUILD,
    '--user',
    OWNER,
    '--account',
    'user-1',
    '--default-project',
    'orca'
  )
  const machine = await harness.machineWith('user-1', [project('orca')])
  await harness.message({ messageId: MENTION, text: 'fix it', mentioned: true })
  const [start] = ConnectorPollResponseSchema.parse((await machine.poll()).body).deliveries
  let seq = 0
  const events = async (...batch: unknown[]) => {
    const response = await machine.call(CONNECTOR_PATHS.events, {
      v: 1,
      helloRev: 1,
      seq: ++seq,
      events: batch
    })
    expect(response.status).toBe(204)
  }
  return { ...harness, machine, start, events }
}
