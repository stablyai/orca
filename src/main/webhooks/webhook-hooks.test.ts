import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger,
  type AutomationWebhookTrigger
} from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import { webhookRuleId } from '../../shared/connector-webhook-contract'
import type { ConnectorResult } from '../connector-cloud/connector-cloud-request'
import type { WebhookView } from '../../shared/connector-webhook-routes'
import type { WebhookCloudCalls } from './webhook-cloud-routes'
import { WebhookHooks, WEBHOOKS_UNSUPPORTED } from './webhook-hooks'
import { WebhookHostLedger } from './webhook-host-ledger'

const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
const NOW = 1_800_000_000_000

const ok = <T>(value: T): ConnectorResult<T> => ({ ok: true, value })
const failed = (status: number | null, error: string | null = null): ConnectorResult<never> => ({
  ok: false,
  status,
  error,
  retryAfterMs: null
})

const cloudHook = (state: WebhookView['state'], epoch = 1): WebhookView => ({
  hookId: HOOK,
  automationId: 'auto-1',
  botId: 'bot-1',
  state,
  epoch,
  url: `https://hooks.orca.test/hooks/${HOOK}`,
  adapter: null,
  lastCall: null,
  keyGeneration: 1,
  pendingCalls: 0,
  previousKeyExpiresAt: null
})

const draft: AutomationWebhookTrigger = {
  id: '',
  source: 'webhook',
  event: 'call',
  rev: 0,
  where: [{ path: 'body.action', op: '=', values: ['opened'] }]
}
const slack: AutomationEventTrigger = { id: 't1', source: 'slack', event: 'mentioned' }

function automation(overrides: Partial<Automation> = {}): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hooks read only these fields.
  return {
    id: 'auto-1',
    enabled: true,
    bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
    on: [{ ...draft, id: webhookRuleId(HOOK), rev: 1 }],
    ...EVENT_ONLY_SCHEDULE,
    ...overrides
  } as Automation
}

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-webhook-hooks-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

function setup(
  cloud: Partial<Record<keyof WebhookCloudCalls, unknown>>,
  automations: Automation[] = []
) {
  const ledger = new WebhookHostLedger(userDataPath, () => 'acct-1')
  const confirmed = vi.fn()
  let now = NOW
  const store = {
    list: () => automations,
    setTriggers: vi.fn(),
    remove: vi.fn()
  }
  const hooks = new WebhookHooks({
    ledger,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test gives the routes it reaches.
    cloud: cloud as unknown as WebhookCloudCalls,
    automations: store,
    botExists: (botId) => botId === 'bot-1',
    confirmed,
    now: () => now
  })
  return { ledger, hooks, store, confirmed, later: (ms: number) => (now += ms) }
}

describe('a webhook on its host', () => {
  it('writes the ledger when a read brings news, never for a read that repeats it', () => {
    const { hooks } = setup({})
    const file = join(userDataPath, 'webhook-host.json')
    hooks.remember(cloudHook('live'))
    expect(existsSync(file)).toBe(true)

    // Each card read remembers what the cloud said; the same answer writes nothing.
    rmSync(file)
    hooks.remember(cloudHook('live'))
    hooks.remember(cloudHook('orphaned'))
    expect(existsSync(file)).toBe(false)

    hooks.remember(cloudHook('paused', 2))
    expect(existsSync(file)).toBe(true)
  })

  it('writes a repeated answer again after a write failed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { hooks } = setup({})
    const file = join(userDataPath, 'webhook-host.json')
    // A folder where the file goes makes the write fail.
    mkdirSync(file)
    hooks.remember(cloudHook('live'))
    rmSync(file, { recursive: true })

    hooks.remember(cloudHook('live'))
    expect(existsSync(file)).toBe(true)
    vi.restoreAllMocks()
  })

  it('is made from a draft once, idempotently, and kept with its URL on an edit', async () => {
    const mint = vi
      .fn()
      .mockResolvedValueOnce(failed(null))
      .mockResolvedValueOnce(ok(cloudHook('pending')))
    const { hooks, ledger } = setup({ mint })
    const made = await hooks.settle({
      automationId: 'auto-1',
      botId: 'bot-1',
      current: undefined,
      next: [slack, draft]
    })
    expect(made.on).toEqual([slack, { ...draft, id: webhookRuleId(HOOK), rev: 1 }])
    // A lost answer is asked again with the same operation.
    expect(mint.mock.calls[0]?.[0]).toEqual(mint.mock.calls[1]?.[0])
    expect(ledger.intents()).toMatchObject([{ operationId: made.operationId, hookId: HOOK }])
    hooks.saved(made.operationId)
    expect(ledger.intents()).toEqual([])

    const current = automation()
    const same = await hooks.settle({
      automationId: 'auto-1',
      botId: 'bot-1',
      current,
      next: [draft]
    })
    expect(same.on).toEqual(current.on)
    const edited = await hooks.settle({
      automationId: 'auto-1',
      botId: 'bot-1',
      current,
      next: [{ ...draft, where: [{ path: 'body.action', op: 'exists' }] }]
    })
    expect(edited.on[0]).toMatchObject({ id: webhookRuleId(HOOK), rev: 2 })
    expect(mint).toHaveBeenCalledTimes(2)
    await expect(
      hooks.settle({
        automationId: 'auto-1',
        botId: 'bot-1',
        current,
        next: [{ ...draft, id: webhookRuleId('wh_0000000000000000'), rev: 1 }]
      })
    ).rejects.toThrow("A webhook's id comes from Orca Cloud")
  })

  it("relays the cloud's refusal at mint in words the bot can pass on", async () => {
    const refusing = (answer: ConnectorResult<never>) =>
      setup({ mint: vi.fn().mockResolvedValue(answer) }).hooks.settle({
        automationId: 'auto-1',
        botId: 'bot-1',
        current: undefined,
        next: [draft]
      })
    await expect(refusing(failed(404))).rejects.toThrow(WEBHOOKS_UNSUPPORTED)
    await expect(refusing(failed(409, 'account_webhook_cap'))).rejects.toThrow(
      'This account has 100 webhooks; delete one first.'
    )
    await expect(refusing(failed(409, 'automation_has_webhook'))).rejects.toThrow(
      'This automation already has a webhook'
    )
    await expect(refusing(failed(409, 'bot_not_on_host'))).rejects.toThrow(
      "Orca Cloud doesn't yet know this bot is on this computer."
    )
  })

  it('pauses, resumes and deletes the hook with its automation, and leaves one being made alone', async () => {
    const setState = vi.fn(async (_hookId: string, body: { state: 'live' | 'paused' }) =>
      ok(cloudHook(body.state, 2))
    )
    const remove = vi.fn(async () => ok(undefined))
    const get = vi.fn(async () => ok(cloudHook('live')))
    const automations = [automation({ enabled: false })]
    const { hooks, ledger } = setup({ setState, remove, get }, automations)
    ledger.saveHook({
      hookId: HOOK,
      automationId: 'auto-1',
      botId: 'bot-1',
      epoch: 1,
      state: 'pending'
    })
    await hooks.reconcile()
    expect(setState).toHaveBeenCalledWith(HOOK, expect.objectContaining({ state: 'paused' }))
    expect(ledger.hook(HOOK)).toMatchObject({ state: 'paused', epoch: 2 })

    // A hook minted for a create still saving isn't anyone's yet.
    automations.length = 0
    ledger.saveIntent({
      operationId: 'op-1',
      automationId: 'auto-2',
      botId: 'bot-1',
      hookId: HOOK,
      createdAt: NOW
    })
    await hooks.reconcile()
    expect(remove).not.toHaveBeenCalled()

    ledger.dropIntent('op-1')
    await hooks.reconcile()
    expect(remove).toHaveBeenCalledWith(HOOK)
    expect(ledger.hook(HOOK)).toBeUndefined()
  })

  it('keeps a pause the cloud missed and retries it, with one operation, before a resume', async () => {
    let up = false
    const setState = vi.fn(async (_hookId: string, body: { state: 'live' | 'paused' }) =>
      up ? ok(cloudHook(body.state, 2)) : failed(503)
    )
    const automations = [automation({ enabled: false })]
    const { hooks, ledger, confirmed, later } = setup({ setState }, automations)
    ledger.saveHook({
      hookId: HOOK,
      automationId: 'auto-1',
      botId: 'bot-1',
      epoch: 1,
      state: 'live'
    })
    await hooks.reconcile()
    const pause = ledger.hook(HOOK)?.change
    expect(pause).toMatchObject({ state: 'paused' })
    // Backing off: a sweep inside the delay sends nothing.
    await hooks.reconcile()
    expect(setState).toHaveBeenCalledTimes(1)
    // A restart still has it; the owner resumed meanwhile.
    automations[0] = automation({ enabled: true })
    const restarted = new WebhookHostLedger(userDataPath, () => 'acct-1')
    expect(restarted.hook(HOOK)?.change).toEqual(pause)
    later(30_001)
    up = true
    await hooks.reconcile()
    // The pause lands first, with its own operation, then the resume.
    expect(setState.mock.calls.map(([, body]) => body)).toEqual([
      pause,
      pause,
      expect.objectContaining({ state: 'live' })
    ])
    expect(ledger.hook(HOOK)).toMatchObject({ state: 'live' })
    expect(ledger.hook(HOOK)?.change).toBeUndefined()
    expect(confirmed).toHaveBeenCalledTimes(2)
  })

  it('retries a failed delete until the cloud confirms it', async () => {
    const remove = vi.fn().mockResolvedValueOnce(failed(503)).mockResolvedValue(failed(404))
    const { hooks, ledger } = setup({ remove }, [])
    ledger.saveHook({
      hookId: HOOK,
      automationId: 'auto-1',
      botId: 'bot-1',
      epoch: 1,
      state: 'live'
    })
    await hooks.reconcile()
    expect(ledger.hook(HOOK)?.change).toMatchObject({ state: 'deleted' })
    await hooks.retryNow()
    expect(remove).toHaveBeenCalledTimes(2)
    expect(ledger.hook(HOOK)).toBeUndefined()
  })

  it.each([400, 403, 409])('stops sending a change the cloud refuses with %i', async (status) => {
    const setState = vi.fn(async () => failed(status))
    const { hooks, ledger } = setup({ setState }, [automation({ enabled: false })])
    ledger.saveHook({
      hookId: HOOK,
      automationId: 'auto-1',
      botId: 'bot-1',
      epoch: 1,
      state: 'live'
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await hooks.reconcile()
    expect(ledger.hook(HOOK)?.change).toBeUndefined()
    warn.mockRestore()
  })

  it.each([401, 408, 429, 503])(
    'keeps a change the cloud answers %i, to send again',
    async (status) => {
      const setState = vi.fn(async () => failed(status))
      const { hooks, ledger } = setup({ setState }, [automation({ enabled: false })])
      ledger.saveHook({
        hookId: HOOK,
        automationId: 'auto-1',
        botId: 'bot-1',
        epoch: 1,
        state: 'live'
      })
      await hooks.reconcile()
      expect(ledger.hook(HOOK)?.change).toMatchObject({ state: 'paused' })
    }
  )

  it('drops a hook deleted while away, and an automation it alone started', () => {
    const alone = automation()
    const withSlack = automation({
      id: 'auto-2',
      on: [slack, { ...draft, id: webhookRuleId(HOOK), rev: 1 }]
    })
    const first = setup({}, [alone])
    first.hooks.dropTombstoned([HOOK])
    expect(first.store.remove).toHaveBeenCalledWith('auto-1')
    const second = setup({}, [withSlack])
    second.hooks.dropTombstoned([HOOK])
    expect(second.store.setTriggers).toHaveBeenCalledWith('auto-2', [slack])
  })
})
