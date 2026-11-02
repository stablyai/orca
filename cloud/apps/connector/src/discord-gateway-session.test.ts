import { createServer, type Server } from 'node:http'
import { REST } from '@discordjs/rest'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { z } from 'zod'
import {
  startDiscordGatewaySession,
  type DiscordGatewaySession,
  type GatewayCheckpoint,
  type GatewayStep
} from './discord-gateway-session.js'
import { createDiscordRestApi } from './discord-rest.js'

// A fake Discord: GET /gateway/bot and /users/@me over HTTP, and a gateway speaking the payloads in
// https://docs.discord.com/developers/events/gateway (Hello, Identify, Ready, Dispatch, Resume)
// with close codes from https://docs.discord.com/developers/topics/opcodes-and-status-codes.
const BOT = '1200000000000000000'
const OWNER = '900000000000000000'
const FrameSchema = z.object({ op: z.number(), d: z.unknown() })
type Frame = z.infer<typeof FrameSchema>

class Connection {
  private readonly frames: Frame[] = []
  private waiting: ((frame: Frame) => void) | undefined
  readonly closed: Promise<number>

  constructor(
    readonly socket: ServerSocket,
    readonly path: string
  ) {
    socket.on('message', (data) => {
      const frame = FrameSchema.parse(JSON.parse(String(data)))
      const waiting = this.waiting
      this.waiting = undefined
      if (waiting) {
        waiting(frame)
      } else {
        this.frames.push(frame)
      }
    })
    this.closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)))
    this.send({ op: 10, d: { heartbeat_interval: 60_000 } })
  }

  // The next frame other than a heartbeat.
  async next(): Promise<Frame> {
    for (;;) {
      const frame =
        this.frames.shift() ?? (await new Promise<Frame>((resolve) => (this.waiting = resolve)))
      if (frame.op !== 1) {
        return frame
      }
      this.send({ op: 11 })
    }
  }

  send(payload: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(payload))
  }
}

let http: Server | undefined
let gateway: WebSocketServer | undefined
// Starting resolves once the gateway is ready, so tests drive the fake while it is pending.
let session: Promise<DiscordGatewaySession> | undefined

afterEach(async () => {
  for (const client of gateway?.clients ?? []) {
    client.close(4004)
  }
  await (await session?.catch(() => undefined))?.close({ drain: true }).catch(() => undefined)
  for (const client of gateway?.clients ?? []) {
    client.terminate()
  }
  await new Promise((resolve) => gateway?.close(resolve) ?? resolve(undefined))
  await new Promise((resolve) => http?.close(resolve) ?? resolve(undefined))
  session = undefined
})

async function fakeDiscord() {
  const requested: string[] = []
  // Channel objects: https://docs.discord.com/developers/resources/channel
  const channels: Record<string, unknown> = {
    '/api/v10/channels/C1': { id: 'C1', type: 0, guild_id: 'G1' },
    '/api/v10/channels/T7': { id: 'T7', type: 11, guild_id: 'G1', parent_id: 'C7' }
  }
  const server = createServer((request, response) => {
    const url = request.url ?? ''
    requested.push(url)
    // A deleted channel.
    if (url === '/api/v10/channels/C9') {
      response.statusCode = 404
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 10003, message: 'Unknown Channel' }))
      return
    }
    response.setHeader('content-type', 'application/json')
    const gatewayBot = {
      url: origin,
      shards: 1,
      session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 }
    }
    const me = { id: BOT, username: 'Orca', bot: true }
    response.end(JSON.stringify(url === '/api/v10/users/@me' ? me : (channels[url] ?? gatewayBot)))
  })
  http = server
  gateway = new WebSocketServer({ server })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('no port')
  }
  const origin = `ws://127.0.0.1:${address.port}`
  const connections: Connection[] = []
  let arrived: ((connection: Connection) => void) | undefined
  gateway.on('connection', (socket, request) => {
    const connection = new Connection(socket, request.url ?? '')
    const waiting = arrived
    arrived = undefined
    if (waiting) {
      waiting(connection)
    } else {
      connections.push(connection)
    }
  })
  const nextConnection = async () =>
    connections.shift() ?? (await new Promise<Connection>((resolve) => (arrived = resolve)))
  return {
    origin,
    nextConnection,
    requested,
    rest: new REST({ api: `http://127.0.0.1:${address.port}/api` }),
    // The real single-attempt client, pointed at the fake.
    api: createDiscordRestApi((input, init) =>
      fetch(String(input).replace('https://discord.com', `http://127.0.0.1:${address.port}`), init)
    )
  }
}

async function start(
  options: {
    resumeFrom?: (origin: string) => GatewayCheckpoint
    failAt?: number
    // Runs before the commit of the dispatch at `failAt`, which then fails.
    beforeFailing?: Promise<void>
  } = {}
) {
  const discord = await fakeDiscord()
  const steps: GatewayStep[] = []
  const fatal: string[] = []
  session = startDiscordGatewaySession({
    token: 'bot-token',
    rest: discord.rest,
    api: discord.api,
    guildIds: new Set(['G1']),
    resumeFrom: options.resumeFrom?.(discord.origin) ?? null,
    commit: async (step) => {
      if (step.checkpoint.sequence === options.failAt) {
        await options.beforeFailing
        throw new Error('database down')
      }
      steps.push(step)
    },
    onFatal: (reason) => fatal.push(reason)
  })
  // A refused start rejects; the test reads that through onFatal.
  session.catch(() => undefined)
  return { ...discord, steps, fatal }
}

const ready = (origin: string, sessionId = 'session-1') => ({
  op: 0,
  s: 1,
  t: 'READY',
  d: {
    v: 10,
    user: { id: BOT, username: 'Orca', bot: true },
    guilds: [],
    session_id: sessionId,
    resume_gateway_url: `${origin}/resume`,
    shard: [0, 1],
    application: { id: BOT, flags: 0 }
  }
})

const messageCreate = (seq: number, overrides: Record<string, unknown>) => ({
  op: 0,
  s: seq,
  t: 'MESSAGE_CREATE',
  d: {
    id: `m${seq}`,
    channel_id: 'C1',
    guild_id: 'G1',
    author: { id: OWNER, username: 'owner' },
    member: { nick: 'Sam' },
    content: 'hello',
    mentions: [],
    mention_roles: [],
    type: 0,
    ...overrides
  }
})

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; !check() && tries < 300; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(check()).toBe(true)
}

const mention = { content: `<@${BOT}> fix the build`, mentions: [{ id: BOT }] }

describe('startDiscordGatewaySession', () => {
  it('identifies with our intents and commits every dispatch in order, with the person’s messages', async () => {
    const { origin, nextConnection, steps } = await start()
    const connection = await nextConnection()
    expect(connection.path).toBe('/?v=10&encoding=json')
    expect(await connection.next()).toMatchObject({
      op: 2,
      d: {
        token: 'bot-token',
        intents: 33281,
        properties: { os: process.platform, browser: 'orca-connector', device: 'orca-connector' }
      }
    })
    connection.send(ready(origin))
    connection.send({ op: 0, s: 2, t: 'TYPING_START', d: { channel_id: 'C1' } })
    connection.send(messageCreate(3, mention))
    connection.send(messageCreate(4, { channel_id: 'T1', content: 'also check CI', type: 19 }))
    connection.send(messageCreate(5, { channel_id: 'T1', author: { id: 'B2', bot: true } }))
    await until(() => steps.length === 5)
    const checkpoint = { sessionId: 'session-1', resumeURL: `${origin}/resume` }
    expect(steps.map((step) => step.checkpoint)).toEqual(
      [1, 2, 3, 4, 5].map((sequence) => ({ ...checkpoint, sequence }))
    )
    expect(steps.map((step) => step.message)).toEqual([
      null,
      null,
      {
        guildId: 'G1',
        channelId: 'C1',
        messageId: 'm3',
        userId: OWNER,
        userName: 'Sam',
        text: 'fix the build',
        mentioned: true
      },
      {
        guildId: 'G1',
        channelId: 'T1',
        messageId: 'm4',
        userId: OWNER,
        userName: 'Sam',
        text: 'also check CI',
        mentioned: false
      },
      null
    ])
  })

  it('looks up a mention’s unknown channel once, skips one that is gone, and ignores other servers', async () => {
    const { origin, nextConnection, steps, requested, fatal } = await start()
    const connection = await nextConnection()
    await connection.next()
    connection.send(ready(origin))
    connection.send(messageCreate(2, { ...mention, channel_id: 'C9' }))
    connection.send(messageCreate(3, { ...mention, channel_id: 'T7' }))
    connection.send(messageCreate(4, { ...mention, channel_id: 'T7' }))
    connection.send(messageCreate(5, { ...mention, channel_id: 'C8', guild_id: 'G2' }))
    await until(() => steps.length === 5)
    expect(
      steps.map((step) => step.message?.threadParentId ?? step.message?.messageId ?? null)
    ).toEqual([null, null, 'C7', 'C7', null])
    expect(requested.filter((url) => url.startsWith('/api/v10/channels/'))).toEqual([
      '/api/v10/channels/C9',
      '/api/v10/channels/T7'
    ])
    expect(fatal).toEqual([])
  })

  it('stops at a dispatch it couldn’t commit, so the next leader replays from the one before', async () => {
    const { origin, nextConnection, steps, fatal } = await start({ failAt: 3 })
    const connection = await nextConnection()
    await connection.next()
    connection.send(ready(origin))
    connection.send(messageCreate(2, mention))
    connection.send(messageCreate(3, mention))
    connection.send(messageCreate(4, mention))
    await until(() => fatal.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fatal).toEqual(['dispatch_failed'])
    expect(steps.map((step) => step.checkpoint.sequence)).toEqual([1, 2])
  })

  it('resumes from the committed checkpoint, and starts afresh when Discord refuses the resume', async () => {
    const { origin, nextConnection, steps } = await start({
      resumeFrom: (origin) => ({
        sessionId: 'session-1',
        sequence: 7,
        resumeURL: `${origin}/resume`
      })
    })
    const resumed = await nextConnection()
    expect(resumed.path).toBe('/resume?v=10&encoding=json')
    expect(await resumed.next()).toEqual({
      op: 6,
      d: { token: 'bot-token', session_id: 'session-1', seq: 7 }
    })
    // Invalid session, not resumable.
    resumed.send({ op: 9, d: false })
    const fresh = await nextConnection()
    expect(await fresh.next()).toMatchObject({ op: 2 })
    fresh.send(ready(origin, 'session-2'))
    fresh.send(messageCreate(2, mention))
    await until(() => steps.length === 2)
    expect(steps.map((step) => step.checkpoint)).toEqual([
      { sessionId: 'session-2', resumeURL: `${origin}/resume`, sequence: 1 },
      { sessionId: 'session-2', resumeURL: `${origin}/resume`, sequence: 2 }
    ])
  })

  it('drops what is left of a refused session, even a dispatch failing after the fresh READY', async () => {
    const failing = Promise.withResolvers<void>()
    const { origin, nextConnection, steps, fatal } = await start({
      resumeFrom: (origin) => ({
        sessionId: 'session-1',
        sequence: 7,
        resumeURL: `${origin}/resume`
      }),
      failAt: 8,
      beforeFailing: failing.promise
    })
    const resumed = await nextConnection()
    await resumed.next()
    resumed.send(messageCreate(8, mention))
    resumed.send(messageCreate(9, mention))
    resumed.send({ op: 9, d: false })
    const fresh = await nextConnection()
    await fresh.next()
    fresh.send(ready(origin, 'session-2'))
    fresh.send(messageCreate(2, mention))
    await new Promise((resolve) => setTimeout(resolve, 50))
    failing.resolve()
    await until(() => steps.length === 2)
    expect(fatal).toEqual([])
    expect(steps.map((step) => [step.checkpoint.sessionId, step.checkpoint.sequence])).toEqual([
      ['session-2', 1],
      ['session-2', 2]
    ])
  })

  it('hands over by closing resumably', async () => {
    const { origin, nextConnection, steps } = await start()
    const connection = await nextConnection()
    await connection.next()
    connection.send(ready(origin))
    await until(() => steps.length === 1)
    await (await session)?.close({ drain: true })
    session = undefined
    expect(await connection.closed).toBe(4200)
  })

  it('reports a refused token as fatal', async () => {
    const { nextConnection, fatal } = await start()
    const connection = await nextConnection()
    await connection.next()
    connection.socket.close(4004)
    await until(() => fatal.length === 1)
    expect(fatal).toEqual(['close_4004'])
  })
})
