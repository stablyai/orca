import { createHmac, randomBytes } from 'node:crypto'
import {
  CONNECTOR_PATHS,
  ConnectorPollResponseSchema,
  type ConnectorProject
} from '@orca-cloud/connector-contract'
import { expect, vi } from 'vitest'
import { createConnectorHarness } from './connector-server-harness.test-fixture.js'
import type { SlackConfig } from './slack-config.js'
import { runSlackOperator } from './slack-operator.js'

export const SIGNING_SECRET = 'test-signing-secret'
export const APP = 'A1'
export const TEAM = 'T1'
export const CHANNEL = 'C1'
export const BOT = 'UBOT'
export const OWNER = 'U1'
export const TEAMMATE = 'U2'

type SlackCall = { method: string; args: Record<string, unknown> }

// Stands in for slack.com/api behind the real HTTP client: records each call and answers with
// queued responses, else a plain success.
function fakeSlack() {
  const calls: SlackCall[] = []
  const queued = new Map<string, Response[]>()
  let ts = 0
  vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = url.pathname.replace('/api/', '')
    const args: Record<string, unknown> =
      typeof init?.body === 'string' ? JSON.parse(init.body) : Object.fromEntries(url.searchParams)
    calls.push({ method, args })
    const response = queued.get(method)?.shift()
    if (response) {
      return response
    }
    if (method === 'users.info') {
      return Response.json({ ok: true, user: { team_id: TEAM, profile: { display_name: 'Bob' } } })
    }
    return Response.json({ ok: true, ts: `1800000100.${String(++ts).padStart(6, '0')}` })
  })
  return {
    calls,
    respond: (method: string, ...responses: Response[]) => {
      queued.set(method, [...(queued.get(method) ?? []), ...responses])
    },
    take: (method?: string) => {
      const taken = calls.filter((call) => method === undefined || call.method === method)
      calls.length = 0
      return taken
    }
  }
}

export function project(name: string, placeId = `pl_${name}`, remote?: string): ConnectorProject {
  return { placeId, name, ...(remote ? { remote } : {}), kind: 'git', where: { kind: 'local' } }
}

export async function createSlackHarness(slack: Partial<SlackConfig> = {}) {
  const fake = fakeSlack()
  const tokenKey = randomBytes(32)
  const harness = await createConnectorHarness({
    slack: {
      paused: false,
      tokenKey,
      ...slack
    }
  })
  const edge = harness.runtime.slack
  if (!edge) {
    throw new Error('Slack edge not configured')
  }
  const operator = (...argv: string[]) =>
    runSlackOperator(argv, {
      database: harness.database,
      tokenKey,
      readSecret: async () =>
        argv[0] === 'register-app'
          ? JSON.stringify({ clientSecret: 'test-client-secret', signingSecret: SIGNING_SECRET })
          : 'xoxb-test-token',
      now: harness.now
    })
  await operator('register-app', '--app-id', APP, '--client-id', '1.2')
  await operator('install', '--team', TEAM, '--bot-user', BOT, '--app-id', APP)

  const signedPost = (
    body: string,
    timestamp = Math.floor(harness.now() / 1000),
    path = `/slack/apps/${APP}/events`,
    contentType = 'application/json'
  ) =>
    harness.request(path, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-slack-request-timestamp': String(timestamp),
        'x-slack-signature': `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`
      },
      body
    })

  // One Slack post as an Events API callback; `type` lets a test send the app_mention twin.
  const message = (
    fields: {
      user?: string
      text: string
      ts: string
      thread_ts?: string
      channel?: string
    } & Record<string, unknown>,
    envelope: Record<string, unknown> = {}
  ) =>
    signedPost(
      JSON.stringify({
        type: 'event_callback',
        api_app_id: APP,
        team_id: TEAM,
        event: {
          type: 'message',
          user: OWNER,
          channel: CHANNEL,
          channel_type: 'channel',
          ...fields
        },
        ...envelope
      })
    )

  // A button press, form-encoded as Slack sends interactions.
  const click = (fields: { user?: string; messageTs: string; value: string; actionId?: string }) =>
    signedPost(
      new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          api_app_id: APP,
          team: { id: TEAM },
          user: { id: fields.user ?? OWNER },
          channel: { id: CHANNEL },
          container: { type: 'message', message_ts: fields.messageTs, channel_id: CHANNEL },
          actions: [{ action_id: fields.actionId ?? 'answer:0', value: fields.value }]
        })
      }).toString(),
      undefined,
      `/slack/apps/${APP}/interactivity`,
      'application/x-www-form-urlencoded'
    )

  // A connected machine of `account` listing `projects`.
  async function machineWith(
    account: string,
    projects: ConnectorProject[],
    hostName = 'build-box'
  ) {
    const machine = await harness.machine(account)
    const response = await machine.call(
      CONNECTOR_PATHS.hello,
      {
        v: 1,
        contract: 1,
        hostName,
        platform: 'darwin',
        runtime: 'desktop',
        orcaVersion: '1.4.230',
        agents: ['claude', 'codex'],
        promptKinds: ['approval'],
        features: ['answer', 'cancel', 'reply'],
        sources: ['slack'],
        projects
      },
      'PUT'
    )
    if (response.status !== 200) {
      throw new Error(`hello failed: ${response.status}`)
    }
    return machine
  }

  const posts = async () =>
    await harness.database.query(
      'SELECT post_id, kind, body, state, next_at, message_ref FROM connector_posts ORDER BY post_id'
    )

  return {
    ...harness,
    core: harness.runtime.core,
    edge,
    fake,
    tokenKey,
    operator,
    signedPost,
    message,
    click,
    machineWith,
    posts
  }
}

export const THREAD = '1800000000.000100'
export const EXTERNAL_ID = `${TEAM}:${CHANNEL}:${THREAD}:${OWNER}`
export const conversation = { source: 'slack' as const, externalId: EXTERNAL_ID }
export const TURN = 1_800_000_001_000

// A linked owner's conversation, its start handed to their machine.
export async function startedThread() {
  const harness = await createSlackHarness()
  await harness.operator(
    'link',
    '--team',
    TEAM,
    '--user',
    OWNER,
    '--account',
    'user-1',
    '--default-project',
    'orca'
  )
  const machine = await harness.machineWith('user-1', [project('orca')])
  await harness.message({ text: `<@${BOT}> fix it`, ts: THREAD })
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
  const status = async () => {
    const [row] = await harness.database.query(
      'SELECT body FROM connector_posts WHERE post_id = ?',
      [`status:${EXTERNAL_ID}`]
    )
    return JSON.parse(String(row?.body)).text
  }
  const reply = (replyId: string, text: string, by = machine) =>
    by.call(CONNECTOR_PATHS.replies, { v: 1, replyId, conversation, turnId: TURN, text })
  const pass = () => harness.core.sendDue()
  return { ...harness, machine, start, events, status, reply, pass }
}

export const turnStarted = { kind: 'turn-started', conversation, paneKey: 'pane-1', at: TURN }
export const turnEnded = {
  kind: 'turn-ended',
  conversation,
  paneKey: 'pane-1',
  turnId: TURN,
  at: TURN + 5_000,
  stopReason: 'end_turn',
  lastAssistantMessage: 'Fixed <!channel> & done'
}
