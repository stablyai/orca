import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { AUTOMATION_HANDLERS } from './automations'
import { BOTS_DISABLED_CODE, BOTS_DISABLED_MESSAGE } from '../../shared/bots-switch'

function host(options: { bots?: boolean; botsOff?: boolean; threadReplies?: boolean } = {}) {
  const writes: unknown[] = []
  const call = vi.fn(async (method: string, params?: unknown) => {
    const meta = { runtimeId: 'runtime-1' }
    if (method === 'bots.list') {
      if (options.bots === false) {
        throw new RuntimeClientError('method_not_found', 'Unknown method: bots.list')
      }
      const slack = { appId: 'A1', teamId: 'T1' }
      const bots = [{ id: 'bot-1', name: 'Reviewer', agent: 'codex', slack }]
      const threadReplies = options.threadReplies ?? true
      return { id: 'request-1', ok: true as const, result: { bots, threadReplies }, _meta: meta }
    }
    if (method === 'status.get') {
      return { id: 'request-1', ok: true as const, result: { capabilities: [] }, _meta: meta }
    }
    if (method === 'automation.create') {
      if (options.botsOff) {
        throw new RuntimeClientError(BOTS_DISABLED_CODE, BOTS_DISABLED_MESSAGE)
      }
      writes.push(params)
      return {
        id: 'request-1',
        ok: true as const,
        result: { automation: { id: 'a1' } },
        _meta: meta
      }
    }
    throw new Error(`unexpected ${method}`)
  })
  const client = new RuntimeClient('/tmp/orca-bot-automation-cli-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  return { client, writes }
}

function create(client: RuntimeClient, extra: [string, string][]) {
  return AUTOMATION_HANDLERS['automations create']!({
    client,
    cwd: '/tmp',
    flags: new Map<string, string | boolean>([
      ['name', 'Morning digest'],
      ['prompt', 'Summarize the night'],
      ['trigger', 'daily'],
      ...extra
    ]),
    json: true
  })
}

afterEach(() => vi.restoreAllMocks())

describe('orca automations create --bot', () => {
  it('targets the named bot with its agent and the defaults', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host()

    await create(client, [['bot', 'reviewer']])

    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      agentId: 'codex',
      bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
      workspaceMode: 'existing'
    })
    expect(writes[0]).not.toHaveProperty('repo')
    expect(writes[0]).not.toHaveProperty('workspace')
  })

  it('saves its own agent and model, and records that agent', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host()

    await create(client, [
      ['bot', 'reviewer'],
      ['agent', 'claude'],
      ['model', 'opus'],
      ['effort', 'high']
    ])

    expect(writes[0]).toMatchObject({
      agentId: 'claude',
      bot: {
        botId: 'bot-1',
        runsIn: 'new',
        agentSetup: { agent: 'claude', launch: { model: 'opus', options: { effort: 'high' } } }
      }
    })
  })

  it('reads a specific bot chat and a pasted Slack destination together', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host()

    await create(client, [
      ['bot', 'bot-1'],
      ['runs-in', 'chat:side-chat'],
      ['results-to', 'channel:https://acme.slack.com/archives/C0123ABCD']
    ])

    expect(writes[0]).toMatchObject({
      bot: {
        botId: 'bot-1',
        runsIn: 'chat',
        chat: { sessionId: 'side-chat' },
        resultsTo: { channel: 'C0123ABCD' }
      }
    })
  })

  it('reads a Linear issue as where results go', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host()

    await create(client, [
      ['bot', 'bot-1'],
      ['results-to', 'linear:ENG-123']
    ])

    expect(writes[0]).toMatchObject({ bot: { resultsTo: { linearIssue: 'ENG-123' } } })
  })

  it.each([
    [[['runs-in', 'chat']], '--runs-in, --results-to, --on and --once need --bot'],
    [
      [
        ['bot', 'Reviewer'],
        ['provider', 'claude']
      ],
      '--provider cannot be used with --bot; use --agent <agent> (with --model/--effort) to run this automation on another agent.'
    ],
    [
      [
        ['bot', 'Reviewer'],
        ['runs-in', 'thread']
      ],
      '--runs-in must be new, chat or chat:<id>'
    ],
    [
      [
        ['bot', 'Reviewer'],
        ['results-to', 'slack']
      ],
      '--results-to must be chat, thread, none, channel:<channel> or linear:<issue>'
    ],
    [[['bot', 'Nobody']], 'No bot named Nobody'],
    [[['agent', 'codex']], '--agent, --model and --effort need --bot'],
    [
      [
        ['bot', 'Reviewer'],
        ['agent', 'claude'],
        ['runs-in', 'chat']
      ],
      "A run in a chat continues on that chat's agent"
    ],
    [
      [
        ['bot', 'Reviewer'],
        ['agent', 'gemini']
      ],
      "Bots can't run on gemini"
    ],
    [
      [
        ['bot', 'Reviewer'],
        ['agent', 'bot'],
        ['model', 'opus']
      ],
      "--agent bot uses the bot's own model; drop --model and --effort."
    ]
  ] satisfies [[string, string][], string][])('refuses %j', async (extra, message) => {
    const { client, writes } = host()
    await expect(create(client, extra)).rejects.toThrow(message)
    expect(writes).toHaveLength(0)
  })

  it('says so when bots are turned off on the host', async () => {
    const { client, writes } = host({ botsOff: true })
    await expect(create(client, [['bot', 'Reviewer']])).rejects.toThrow(
      'Bots are turned off in Settings › Bots'
    )
    expect(writes).toEqual([])
  })

  it('refuses a host without bots instead of targeting the current folder', async () => {
    const { client, writes } = host({ bots: false })
    await expect(create(client, [['bot', 'Reviewer']])).rejects.toMatchObject({
      code: 'method_not_found'
    })
    expect(writes).toHaveLength(0)
  })
})

describe('orca automations edit --runs-in / --results-to', () => {
  function editHost(saved: Record<string, unknown>, after: Record<string, unknown> = saved) {
    const updates: unknown[] = []
    const call = vi.fn(async (method: string, params?: unknown) => {
      const meta = { runtimeId: 'runtime-1' }
      if (method === 'automation.show') {
        return { id: 'r', ok: true as const, result: { automation: saved }, _meta: meta }
      }
      if (method === 'bots.list') {
        const bots = [{ id: 'bot-1', name: 'Reviewer', agent: 'codex', launch: { model: 'm1' } }]
        return { id: 'r', ok: true as const, result: { bots, threadReplies: true }, _meta: meta }
      }
      if (method === 'automation.update') {
        updates.push(params && typeof params === 'object' && 'updates' in params && params.updates)
        return { id: 'r', ok: true as const, result: { automation: after }, _meta: meta }
      }
      throw new Error(`unexpected ${method}`)
    })
    const client = new RuntimeClient('/tmp/orca-bot-automation-cli-test', 60_000, null, null)
    vi.spyOn(client, 'call').mockImplementation(call)
    return { client, updates }
  }

  function edit(client: RuntimeClient, extra: [string, string][]) {
    return AUTOMATION_HANDLERS['automations edit']!({
      client,
      cwd: '/tmp',
      flags: new Map<string, string | boolean>([['id', 'a1'], ...extra]),
      json: true
    })
  }

  const botAutomation = {
    id: 'a1',
    bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
    dtstart: 0,
    rrule: 'FREQ=DAILY'
  }

  it('changes one field and keeps the saved bot and the other field', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, updates } = editHost(botAutomation)

    await edit(client, [['results-to', 'channel:C0123']])

    expect(updates[0]).toMatchObject({
      bot: { botId: 'bot-1', runsIn: 'new', resultsTo: { channel: 'C0123' } }
    })
  })

  it('changes where it runs', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, updates } = editHost(botAutomation)

    await edit(client, [['runs-in', 'chat']])

    expect(updates[0]).toMatchObject({ bot: { botId: 'bot-1', runsIn: 'chat', resultsTo: 'chat' } })
  })

  it('drops a saved chat when it runs somewhere else', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, updates } = editHost({
      ...botAutomation,
      bot: { botId: 'bot-1', runsIn: 'chat', chat: { sessionId: 'side-chat' }, resultsTo: 'chat' }
    })

    await edit(client, [['runs-in', 'chat']])

    expect(updates[0]).toMatchObject({ bot: { runsIn: 'chat', chat: undefined } })
  })

  it('sends no bot target when neither is given', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, updates } = editHost(botAutomation)

    await edit(client, [['name', 'Renamed']])

    expect(updates[0]).not.toHaveProperty('bot')
  })

  it('refuses a bad value before reading the automation', async () => {
    const { client, updates } = editHost(botAutomation)
    await expect(edit(client, [['runs-in', 'thread']])).rejects.toThrow(
      '--runs-in must be new, chat or chat:<id>'
    )
    expect(client.call).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  const ownClaude = {
    ...botAutomation,
    bot: {
      ...botAutomation.bot,
      agentSetup: { agent: 'claude', launch: { model: 'opus', options: { effort: 'high' } } }
    }
  }

  it.each([
    [
      'keeps its own agent and other choices for a new model',
      ownClaude,
      [['model', 'sonnet']],
      { agent: 'claude', launch: { model: 'sonnet', options: { effort: 'high' } } }
    ],
    [
      "starts another agent on its own defaults, dropping the last agent's launch",
      ownClaude,
      [['agent', 'codex']],
      { agent: 'codex' }
    ]
  ] satisfies [string, object, [string, string][], object][])(
    '%s',
    async (_name, saved, extra, agentSetup) => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined)
      const { client, updates } = editHost(saved)

      await edit(client, extra)

      expect(updates[0]).toMatchObject({ bot: { botId: 'bot-1', runsIn: 'new', agentSetup } })
      expect(updates[0]).toHaveProperty('bot.agentSetup', agentSetup)
    }
  )

  it("pins the bot's current agent and launch and reports the switch", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const pinned = {
      ...botAutomation,
      name: 'Morning digest',
      agentId: 'codex',
      enabled: true,
      nextRunAt: 1,
      precheck: null,
      workspaceMode: 'existing',
      bot: {
        ...botAutomation.bot,
        agentSetup: { agent: 'codex', launch: { model: 'm1', options: { effort: 'high' } } }
      }
    }
    const { client, updates } = editHost(botAutomation, pinned)

    await AUTOMATION_HANDLERS['automations edit']!({
      client,
      cwd: '/tmp',
      flags: new Map<string, string | boolean>([
        ['id', 'a1'],
        ['effort', 'high']
      ]),
      json: false
    })

    expect(updates[0]).toMatchObject({
      bot: { botId: 'bot-1', runsIn: 'new', agentSetup: pinned.bot.agentSetup }
    })
    expect(out.mock.calls.map(([line]) => String(line)).join('')).toContain(
      "Pinned to Reviewer's current agent (codex)"
    )
  })

  it("goes back to the bot's agent with --agent bot", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, updates } = editHost(ownClaude)

    await edit(client, [['agent', 'bot']])

    expect(updates[0]).toMatchObject({ bot: { botId: 'bot-1', runsIn: 'new' } })
    expect(updates[0]).not.toHaveProperty('bot.agentSetup')
  })

  it('refuses to keep its own agent in a chat', async () => {
    const { client, updates } = editHost(ownClaude)
    await expect(edit(client, [['runs-in', 'chat']])).rejects.toThrow(
      "A run in a chat continues on that chat's agent"
    )
    expect(updates).toHaveLength(0)
  })

  it("refuses them on an automation that isn't a bot's", async () => {
    const { client, updates } = editHost({ id: 'a1', dtstart: 0, rrule: 'FREQ=DAILY' })
    await expect(edit(client, [['results-to', 'none']])).rejects.toThrow(
      "apply only to a bot's automation"
    )
    expect(updates).toHaveLength(0)
  })
})

describe('--results-to thread', () => {
  function eventCreate(client: RuntimeClient, extra: [string, string][]) {
    return AUTOMATION_HANDLERS['automations create']!({
      client,
      cwd: '/tmp',
      flags: new Map<string, string | boolean>([
        ['name', 'Mentions'],
        ['prompt', 'Answer it'],
        ['bot', 'bot-1'],
        ['on', 'slack.mentioned'],
        ...extra
      ]),
      json: true
    })
  }

  it('is the default for an automation only Slack, GitHub or Linear events start', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host()
    await eventCreate(client, [])
    expect(writes[0]).toMatchObject({ bot: { runsIn: 'new', resultsTo: 'thread' } })
  })

  it("defaults to Chat and refuses thread when the host's Orca Cloud can't bind the thread", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host({ threadReplies: false })
    await eventCreate(client, [])
    await expect(eventCreate(client, [['results-to', 'thread']])).rejects.toThrow(
      "Orca Cloud doesn't support this yet"
    )
    expect(writes).toMatchObject([{ bot: { resultsTo: 'chat' } }])
  })

  it('keeps Chat when it runs in the Chat, and takes thread when asked', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { client, writes } = host()
    await eventCreate(client, [['runs-in', 'chat']])
    await create(client, [
      ['bot', 'bot-1'],
      ['results-to', 'thread']
    ])
    expect(writes).toMatchObject([{ bot: { resultsTo: 'chat' } }, { bot: { resultsTo: 'thread' } }])
  })
})
