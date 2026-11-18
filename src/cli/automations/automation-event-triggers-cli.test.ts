import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../shared/automation-event-triggers'
import { RuntimeClient } from '../runtime/client'
import { AUTOMATION_HANDLERS } from './automations'

// Slack is set up; GitHub and Linear are not.
const RANGER = {
  id: 'bot-1',
  name: 'Ranger',
  agent: 'claude',
  slack: { appId: 'A1', teamId: 'T1' }
}

function host(automations: unknown[] = []) {
  const writes: { method: string; params: unknown }[] = []
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
      case 'automation.show':
        return ok({ automation: { id: 'a1' } })
      case 'automation.list':
        return ok({ automations })
      case 'automation.create':
      case 'automation.update':
        writes.push({ method, params })
        return ok({ automation: { id: 'a1', name: 'x', on: [] } })
    }
    throw new Error(`unexpected ${method}`)
  })
  const client = new RuntimeClient('/tmp/orca-event-trigger-cli-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  return { client, writes, call }
}

function run(command: string, client: RuntimeClient, flags: [string, string | boolean][]) {
  return AUTOMATION_HANDLERS[command]!({
    client,
    cwd: '/tmp',
    flags: new Map<string, string | boolean>(flags),
    json: true
  })
}

const BOT_CREATE: [string, string][] = [
  ['name', 'Deploy pings'],
  ['prompt', 'Answer it'],
  ['bot', 'ranger']
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('orca automations --timezone', () => {
  it('marks a zone given on the command line as named, and sends none otherwise', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host()

    await run('automations create', client, [
      ...BOT_CREATE,
      ['trigger', 'daily'],
      ['timezone', 'Europe/London']
    ])
    await run('automations create', client, [...BOT_CREATE, ['trigger', 'daily']])
    await run('automations edit', client, [
      ['id', 'a1'],
      ['timezone', 'Asia/Tokyo']
    ])

    expect(writes[0]?.params).toMatchObject({ timezone: 'Europe/London', timezoneExplicit: true })
    expect(writes[1]?.params).not.toHaveProperty('timezone')
    expect(writes[1]?.params).not.toHaveProperty('timezoneExplicit')
    expect(writes[2]?.params).toMatchObject({
      updates: { timezone: 'Asia/Tokyo', timezoneExplicit: true }
    })
  })
})

describe('orca automations --on', () => {
  it('creates an event-only bot automation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host()

    await run('automations create', client, [...BOT_CREATE, ['on', 'slack.mentioned in=C1']])

    expect(writes[0]?.params).toMatchObject({
      bot: { botId: 'bot-1' },
      rrule: EVENT_ONLY_SCHEDULE.rrule,
      dtstart: EVENT_ONLY_SCHEDULE.dtstart,
      on: [{ source: 'slack', event: 'mentioned', in: ['C1'] }]
    })
  })

  it('refuses a schedule given with events', async () => {
    const { client, writes } = host()

    await expect(
      run('automations create', client, [
        ...BOT_CREATE,
        ['trigger', 'hourly'],
        ['on', 'slack.message']
      ])
    ).rejects.toThrow('--on starts a run on each event, so drop --trigger')
    expect(writes).toEqual([])
  })

  it('still needs a schedule without events', async () => {
    const { client, writes } = host()
    await expect(run('automations create', client, BOT_CREATE)).rejects.toThrow(
      'Missing required --trigger'
    )
    expect(writes).toEqual([])
  })

  it('replaces the events on edit, and none removes them', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host()

    await run('automations edit', client, [
      ['id', 'a1'],
      ['on', 'none']
    ])
    await run('automations edit', client, [
      ['id', 'a1'],
      ['trigger', 'none']
    ])

    expect(writes[0]?.params).toMatchObject({ id: 'a1', updates: { on: [] } })
    expect(writes[1]?.params).toMatchObject({
      updates: { rrule: EVENT_ONLY_SCHEDULE.rrule, dtstart: EVENT_ONLY_SCHEDULE.dtstart }
    })
  })

  it('asks nothing extra of the host for an edit without events', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, call } = host()

    await run('automations edit', client, [
      ['id', 'a1'],
      ['disabled', true]
    ])

    expect(call.mock.calls.map(([method]) => method)).not.toContain('status.get')
  })

  it('lists the events without a host', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, call } = host()

    await AUTOMATION_HANDLERS['automations trigger-options']!({
      client,
      cwd: '/tmp',
      flags: new Map([['source', 'slack']]),
      json: false
    })

    expect(call).not.toHaveBeenCalled()
    expect(log.mock.calls[0]?.[0]).toContain('slack.reaction')
  })

  it('carries the notes in JSON too', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client } = host()

    await AUTOMATION_HANDLERS['automations trigger-options']!({
      client,
      cwd: '/tmp',
      flags: new Map([['source', 'slack']]),
      json: true
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0])).result.guide).toContain('needs no automation')
  })

  it('refuses an event from a source the bot has no connector for, naming what it has', async () => {
    const { client, writes } = host()
    await expect(
      run('automations create', client, [...BOT_CREATE, ['on', 'github.ci_failed']])
    ).rejects.toThrow(
      'Ranger has no GitHub connector, so github.ci_failed would never start it. It can start on Slack events or on a schedule'
    )
    expect(writes).toEqual([])
  })

  it("lists only a bot's connected sources in full", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client } = host()

    await AUTOMATION_HANDLERS['automations trigger-options']!({
      client,
      cwd: '/tmp',
      flags: new Map([['bot', 'ranger']]),
      json: true
    })

    const { result } = JSON.parse(String(log.mock.calls[0]?.[0]))
    expect(result.connected).toEqual(['slack'])
    expect(result.guide).toContain('slack.reaction  when')
    expect(result.guide).toContain(
      'github: none of these start Ranger, which has no GitHub connector (`orca bot connectors --offer github` shows its owner a Connect card): github.issue_opened'
    )
  })
})

describe('orca automations list', () => {
  const automation = (id: string, on: unknown[]) => ({
    id,
    name: id,
    agentId: 'claude',
    enabled: true,
    bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
    on,
    rrule: EVENT_ONLY_SCHEDULE.rrule,
    dtstart: EVENT_ONLY_SCHEDULE.dtstart,
    nextRunAt: EVENT_ONLY_SCHEDULE.dtstart
  })

  it("marks a saved rule whose connector the bot doesn't have", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client } = host([
      automation('heard', [{ id: 'on-1', source: 'slack', event: 'mentioned' }]),
      automation('unheard', [{ id: 'on-2', source: 'linear', event: 'assigned' }])
    ])

    await AUTOMATION_HANDLERS['automations list']!({
      client,
      cwd: '/tmp',
      flags: new Map(),
      json: true
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0])).result.wontFire).toEqual({
      unheard: "won't fire: Ranger has no Linear connector (linear.assigned)"
    })
  })

  it('asks nothing more of the host when no automation has events', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, call } = host([automation('scheduled', [])])

    await AUTOMATION_HANDLERS['automations list']!({
      client,
      cwd: '/tmp',
      flags: new Map(),
      json: false
    })

    expect(call.mock.calls.map(([method]) => method)).toEqual(['automation.list'])
  })
})
