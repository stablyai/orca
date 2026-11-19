import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../shared/automation-event-triggers'
import { RuntimeClient } from '../runtime/client'
import { AUTOMATION_HANDLERS } from '../automations/automations'
import { WEBHOOK_HANDLERS } from './webhooks'

const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
const CALL = 'call_0123456789abcdefABCD'
const KEY = `orcawh_${'k'.repeat(43)}`
const SCOUT = { id: 'bot-1', name: 'Scout', agent: 'claude' }
const summary = (state: string) => ({
  hookId: HOOK,
  botId: 'bot-1',
  automationId: 'a1',
  state,
  url: `https://hooks.orca.test/hooks/${HOOK}`,
  adapter: null,
  lastCall: null,
  host: 'online'
})

const HOOKED = {
  id: 'a1',
  name: 'Investigate',
  enabled: true,
  on: [{ id: `wh-${HOOK}`, source: 'webhook', event: 'call', rev: 1 }],
  ...EVENT_ONLY_SCHEDULE
}

function host(saved: Record<string, unknown> = HOOKED) {
  const calls: { method: string; params: unknown }[] = []
  const states = ['pending', 'live']
  const call = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params })
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
        return ok({ bots: [SCOUT], webhooks: true })
      case 'automation.create':
      case 'automation.update':
        return ok({ automation: saved })
      case 'automation.show':
        return ok({ automation: HOOKED })
      case 'webhooks.card':
        return ok(summary(states.shift() ?? 'live'))
      case 'webhooks.list':
        return ok({ hooks: [summary('live')] })
      case 'webhooks.calls':
        return ok({
          calls: [
            { kind: 'call', callId: CALL, receivedAt: 1, state: 'started', runId: 'run-1' },
            { kind: 'refused', minute: 0, count: 6 }
          ]
        })
      case 'webhooks.call':
        return ok({ callId: CALL, text: '<<<\n{"body":{}}\n>>>' })
      case 'webhooks.check':
        return ok({ matched: 3, unmatched: 1, unknown: 1 })
      // What a key-handling route would answer, so a call to one would show in the output.
      case 'webhooks.reveal':
        return ok({ key: KEY, url: `https://hooks.orca.test/hooks/${HOOK}/${KEY}` })
    }
    throw new Error(`unexpected ${method}`)
  })
  const client = new RuntimeClient('/tmp/orca-webhooks-cli-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(call)
  return { client, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function output(run: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line))
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  try {
    const done = run()
    await vi.runAllTimersAsync()
    await done
  } finally {
    vi.useRealTimers()
  }
  return lines.join('\n')
}

describe('orca webhooks', () => {
  it('makes a hook with the automation and sends the owner to its card, with no wait', async () => {
    const { client, calls } = host()
    const printed = await output(() =>
      AUTOMATION_HANDLERS['automations create']!({
        client,
        cwd: '/tmp',
        json: false,
        flags: new Map<string, string | boolean>([
          ['name', 'Investigate'],
          ['prompt', 'Look into it'],
          ['bot', 'scout'],
          ['on', 'webhook.call where="body.action = opened"']
        ])
      })
    )
    expect(calls.find(({ method }) => method === 'automation.create')?.params).toMatchObject({
      on: [
        {
          id: '',
          source: 'webhook',
          rev: 0,
          where: [{ path: 'body.action', op: '=', values: ['opened'] }]
        }
      ]
    })
    expect(printed).toContain(`The webhook ${HOOK} was made.`)
    expect(printed).toContain("Copy URL on the automation's card")
    expect(calls.some(({ method }) => method === 'webhooks.card')).toBe(false)
    expect(printed).not.toContain('::orca-webhook')
  })

  // A bot that read the URL from --json pasted it in place of the card.
  it('never gives the bot a URL or a card line, with --json either', async () => {
    const { client } = host()
    const printed = await output(() =>
      AUTOMATION_HANDLERS['automations create']!({
        client,
        cwd: '/tmp',
        json: true,
        flags: new Map<string, string | boolean>([
          ['name', 'Investigate'],
          ['prompt', 'Look into it'],
          ['bot', 'scout'],
          ['on', 'webhook.call']
        ])
      })
    )
    expect(JSON.parse(printed).result.automation.id).toBe('a1')
    const shown = [printed]
    for (const json of [false, true]) {
      for (const [command, flags] of [
        ['webhooks show', [['hook', HOOK]]],
        ['webhooks list', [['bot', 'scout']]]
      ] as const) {
        shown.push(
          await output(() =>
            WEBHOOK_HANDLERS[command]!({ client, cwd: '/tmp', json, flags: new Map(flags) })
          )
        )
      }
    }
    for (const text of shown) {
      expect(text).not.toContain('https://')
      expect(text).not.toContain('orca-webhook')
    }
  })

  it('never waits on a hook, and says nothing for one an edit kept', async () => {
    const kept = host()
    const edited = await output(() =>
      AUTOMATION_HANDLERS['automations edit']!({
        client: kept.client,
        cwd: '/tmp',
        json: false,
        flags: new Map<string, string | boolean>([
          ['id', 'a1'],
          ['on', 'webhook.call contains=deploy']
        ])
      })
    )
    expect(edited).not.toContain('Copy URL')
    expect(kept.calls.some(({ method }) => method === 'webhooks.card')).toBe(false)

    const paused = host({ ...HOOKED, enabled: false })
    const created = await output(() =>
      AUTOMATION_HANDLERS['automations create']!({
        client: paused.client,
        cwd: '/tmp',
        json: false,
        flags: new Map<string, string | boolean>([
          ['name', 'Investigate'],
          ['prompt', 'Look into it'],
          ['bot', 'scout'],
          ['on', 'webhook.call']
        ])
      })
    )
    expect(created).toContain(`The webhook ${HOOK} was made.`)
    expect(paused.calls.some(({ method }) => method === 'webhooks.card')).toBe(false)
  })

  it('never asks for or prints a key, in any command or output', async () => {
    const { client, calls } = host()
    const runs: [string, [string, string][]][] = [
      ['webhooks list', [['bot', 'scout']]],
      ['webhooks show', [['hook', HOOK]]],
      ['webhooks calls', [['hook', HOOK]]],
      [
        'webhooks calls',
        [
          ['hook', HOOK],
          ['call', CALL]
        ]
      ],
      [
        'webhooks check',
        [
          ['hook', HOOK],
          ['on', 'webhook.call where="body.action exists"']
        ]
      ]
    ]
    for (const json of [false, true]) {
      for (const [command, flags] of runs) {
        const printed = await output(() =>
          WEBHOOK_HANDLERS[command]!({ client, cwd: '/tmp', json, flags: new Map(flags) })
        )
        expect(printed).not.toContain('orcawh_')
      }
    }
    expect(calls.filter(({ method }) => /^webhooks\.(reveal|rotate|secret)$/.test(method))).toEqual(
      []
    )
    expect(calls.find(({ method }) => method === 'webhooks.check')?.params).toEqual({
      hookId: HOOK,
      filters: { where: [{ path: 'body.action', op: 'exists' }] }
    })
  })
})
