import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import { webhookRuleId } from '../../shared/connector-webhook-contract'
import { SIGNED_OUT, type ConnectorResult } from '../connector-cloud/connector-cloud-request'
import type { WebhookEnvelope } from '../../shared/connector-webhook-routes'
import type { WebhookCloudCalls } from './webhook-cloud-routes'
import { notifyBotCouldNotFinish } from '../bots/bot-could-not-finish'
import { makeTestBot } from '../bots/bot.test-fixture'
import type { OwnerNotice } from '../runtime/push/notifications/runtime-mobile-notification-controller'
import { WebhookHostService } from './webhook-host-service'

const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
const CALLS = [
  'call_0123456789abcdefABC1',
  'call_0123456789abcdefABC2',
  'call_0123456789abcdefABC3'
]
const ok = <T>(value: T): ConnectorResult<T> => ({ ok: true, value })

const envelope = (action: string, truncated = false): WebhookEnvelope => ({
  receivedAt: 1,
  contentType: 'application/json',
  headers: {},
  body: { kind: 'json', value: { action } },
  truncated
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only these fields.
const automation = {
  id: 'auto-1',
  enabled: true,
  bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
  on: [
    {
      id: webhookRuleId(HOOK),
      source: 'webhook',
      event: 'call',
      rev: 1,
      where: [{ path: 'body.action', op: '=', values: ['opened'] }]
    }
  ],
  ...EVENT_ONLY_SCHEDULE
} as unknown as Automation

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-webhook-service-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

const notices: OwnerNotice[] = []
let couldNotFinish = true
let cloudFeatures: ReadonlySet<string> | null = null

function service(
  routes: Partial<WebhookCloudCalls>,
  overrides: Partial<ConstructorParameters<typeof WebhookHostService>[0]> = {}
) {
  return new WebhookHostService({
    userDataPath,
    account: () => 'acct-1',
    cloud: () => ({
      call: async () => SIGNED_OUT,
      cloudFeatures: () => cloudFeatures,
      withConnection: (run) => run()
    }),
    automations: {
      list: () => [automation],
      runs: () => [],
      setTriggers: vi.fn(),
      remove: vi.fn()
    },
    botFolder: () => null,
    botFolders: () => [],
    botExists: () => true,
    bot: () =>
      makeTestBot({
        name: 'Scout',
        notifications: { needsPermission: true, taskComplete: true, couldNotFinish }
      }),
    notifyOwner: (bot, automation, notice) =>
      notifyBotCouldNotFinish({ notify: (shown) => notices.push(shown) }, bot, automation, notice),
    runForEvent: async () => null,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test gives the routes it reaches.
    routes: routes as WebhookCloudCalls,
    ...overrides
  })
}

describe("this host's webhooks", () => {
  it('runs its cleanup timer only while a call file is left to recover', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const interval = vi.spyOn(globalThis, 'setInterval')
    const folder = join(userDataPath, 'bot-home')
    const routes = { list: async () => ok({ hooks: [] }) }

    const idle = service(routes, { botFolders: () => [folder] })
    await idle.start()
    expect(interval).not.toHaveBeenCalled()
    idle.stop()

    mkdirSync(join(folder, 'webhook-calls'), { recursive: true })
    const stray = join(folder, 'webhook-calls', `${CALLS[0]}.untrusted.json`)
    writeFileSync(stray, '{}')
    const recovering = service(routes, { botFolders: () => [folder] })
    await recovering.start()
    expect(interval).toHaveBeenCalledTimes(1)
    recovering.stop()
    vi.restoreAllMocks()
  })

  it('checks local hook ownership before attempting a cloud read', async () => {
    const get = vi.fn(() => null)
    const webhooks = service({ get })
    await expect(webhooks.card('wh_0000000000000000')).rejects.toThrow('webhook_not_found')
    expect(get).not.toHaveBeenCalled()
    await expect(webhooks.card(HOOK)).rejects.toThrow('webhooks_unavailable')
    expect(get).toHaveBeenCalledWith(HOOK)
  })

  it("checks recent calls against the hook's filters, or others, and can't tell a cut body", async () => {
    const bodies = [envelope('opened'), envelope('closed'), envelope('opened', true)]
    const routes = {
      calls: async () =>
        ok({
          calls: [
            ...CALLS.map((callId) => ({
              kind: 'call' as const,
              callId,
              receivedAt: 1,
              state: 'queued' as const
            })),
            { kind: 'refused' as const, minute: 0, count: 4 }
          ]
        }),
      envelope: async (callId: string) => ok(bodies[CALLS.indexOf(callId)]!)
    }
    expect(await service(routes).check(HOOK)).toEqual({ matched: 1, unmatched: 1, unknown: 1 })
    expect(
      await service(routes).check(HOOK, { where: [{ path: 'body.action', op: 'exists' }] })
    ).toEqual({ matched: 2, unmatched: 0, unknown: 1 })
  })

  it("shows a hook's notice as the owner's couldn't-finish notification, never a Chat turn", () => {
    notices.length = 0
    const notice = {
      deliveryId: 'n-1',
      expiresAt: 2,
      conversation: { source: 'webhook' as const, externalId: 'n-1' },
      kind: 'webhook_notice' as const,
      hookId: HOOK,
      botId: 'bot-1',
      condition: 'cap_reached' as const,
      count: 200,
      at: 1
    }
    const webhooks = service({})
    couldNotFinish = true
    expect(webhooks.notice(notice)).toBe(true)
    // Paired phones get it too: nothing marks it banner-only.
    expect(notices).toEqual([
      expect.objectContaining({
        title: "Scout's webhook needs a look",
        body: expect.stringContaining('200 runs an hour')
      })
    ])
    expect(notices[0]).not.toHaveProperty('phone')
    couldNotFinish = false
    expect(webhooks.notice(notice)).toBe(true)
    expect(notices).toHaveLength(1)
    // Another bot's, or a hook not listed here: not this host's.
    expect(webhooks.notice({ ...notice, botId: 'bot-2' })).toBe(false)
  })

  it("takes webhooks as offered until the poll client's hello answer says otherwise", () => {
    const webhooks = service({})
    cloudFeatures = null
    expect(webhooks.advertised()).toBe(true)
    cloudFeatures = new Set(['review'])
    expect(webhooks.advertised()).toBe(false)
    cloudFeatures = new Set(['webhooks'])
    expect(webhooks.advertised()).toBe(true)
    cloudFeatures = null
  })
})
