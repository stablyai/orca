import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../shared/automation-event-triggers'
import { RuntimeClient } from '../runtime/client'
import { AUTOMATION_HANDLERS } from './automations'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'

const RANGER = {
  id: 'bot-1',
  name: 'Ranger',
  agent: 'claude',
  threadReplies: true,
  slack: { appId: 'A1', teamId: 'T1' }
}

function host() {
  const writes: unknown[] = []
  const call = vi.fn(async (method: string, params?: unknown) => {
    const ok = (result: unknown) => ({
      id: 'request-1',
      ok: true as const,
      result,
      _meta: { runtimeId: 'runtime-1' }
    })
    switch (method) {
      case 'status.get':
        return ok({ capabilities: [] })
      case 'bots.list':
        return ok({ bots: [RANGER] })
      case 'automation.create':
        writes.push(params)
        return ok({ automation: { id: 'a1', name: 'x', on: [] } })
    }
    throw new Error(`unexpected ${method}`)
  })
  const client = new RuntimeClient('/tmp/orca-once-cli-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  return { client, writes }
}

function create(client: RuntimeClient, flags: [string, string | boolean][]) {
  return AUTOMATION_HANDLERS['automations create']!({
    client,
    cwd: '/tmp',
    flags: new Map<string, string | boolean>([
      ['name', "Nora's reply in #orca"],
      ['prompt', 'Tell me what Nora said'],
      ['bot', 'ranger'],
      ...flags
    ]),
    json: true
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('orca automations create --once', () => {
  it("makes a wait that runs and reports in the bot's Chat", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host()
    const by = '2099-11-06T17:00:00-05:00'

    await create(client, [
      ['on', 'slack.message in=C1'],
      ['once', true],
      ['by', by]
    ])

    expect(writes[0]).toMatchObject({
      once: { by: Date.parse(by) },
      bot: { runsIn: 'chat', resultsTo: 'chat' },
      dtstart: EVENT_ONLY_SCHEDULE.dtstart
    })
  })

  it('asks the host to run an automation in the chat that made it, unless --runs-in says where', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'side-chat')
    const { client, writes } = host()
    const wait: [string, string | boolean][] = [
      ['on', 'slack.message in=C1'],
      ['once', true]
    ]

    await create(client, wait)
    await create(client, [...wait, ['runs-in', 'chat']])
    await create(client, [['on', 'slack.message in=C1']])

    expect(writes[0]).toMatchObject({ callerSessionId: 'side-chat', runsInDefault: true })
    expect(writes[1]).toMatchObject({ callerSessionId: 'side-chat' })
    expect(writes[1]).not.toHaveProperty('runsInDefault')
    // The host decides whether a recurring one moves: only a teammate's does.
    expect(writes[2]).toMatchObject({ runsInDefault: true })
  })

  it('takes --by without an event, as a one-time reminder', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host()

    await create(client, [
      ['once', true],
      ['by', '2099-01-01T09:00:00Z']
    ])

    expect(writes[0]).toMatchObject({ once: { by: Date.parse('2099-01-01T09:00:00Z') } })
  })

  it('refuses --by without --once, or a time already past', async () => {
    const { client } = host()

    await expect(
      create(client, [
        ['on', 'slack.message in=C1'],
        ['by', '2099-01-01T09:00:00Z']
      ])
    ).rejects.toThrow('--by needs --once')
    await expect(
      create(client, [
        ['once', true],
        ['by', '2001-01-01T09:00:00Z']
      ])
    ).rejects.toThrow('--by must be a time in the future')
  })
})
