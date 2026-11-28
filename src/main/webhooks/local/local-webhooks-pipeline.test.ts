import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import type { AutomationRunEvent } from '../../../shared/automation-event-triggers'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { WebhookHostLedger } from '../webhook-host-ledger'
import { WebhookHostService } from '../webhook-host-service'
import { deliverLocalCall } from './local-webhook-delivery'
import { createLocalWebhookHandler } from './local-webhook-listener'
import { localWebhookCalls } from './local-webhook-routes'
import { LocalWebhookStore } from './local-webhook-store'
import { webhookRuleId } from '../../../shared/connector-webhook-contract'
import { listenOnLoopback, webhookAutomation } from './local-webhook.test-fixture'

let dir: string | undefined
let server: Server | undefined
let service: WebhookHostService | undefined
afterEach(() => {
  service?.stop()
  server?.close()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('a local webhook call', () => {
  it("runs its bot's automation through the host's webhook pipeline", async () => {
    dir = mkdtempSync(join(tmpdir(), 'local-webhooks-pipeline-'))
    const botFolder = join(dir, 'bot')
    mkdirSync(botFolder)
    const store = new LocalWebhookStore(dir)
    const hook = await store.mint('op-1', 'auto-1', 'bot-1')
    const automation = webhookAutomation(hook)
    const started: { event: AutomationRunEvent; runId: string }[] = []
    let deliver: Parameters<typeof deliverLocalCall>[0]
    const routes = localWebhookCalls({
      store,
      baseUrl: () => 'http://127.0.0.1:6790',
      deliver: (entry, call) => deliverLocalCall(deliver, entry, call)
    })
    service = new WebhookHostService({
      userDataPath: dir,
      account: () => 'local-webhooks',
      cloud: () => null,
      local: () => routes,
      automations: {
        list: () => [automation],
        runs: () => [],
        setTriggers: () => {},
        remove: () => {}
      },
      botFolder: () => botFolder,
      botFolders: () => [botFolder],
      botExists: () => true,
      newerAgentBotIds: () => new Set(),
      bot: () => undefined,
      notifyOwner: () => {},
      runForEvent: async (_id, _event, gate) => {
        const reserved = await gate.reserve(automation)
        if (!('runId' in reserved)) {
          return null
        }
        started.push(reserved)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the webhook pipeline reads only a run's id, status and error.
        const run = { id: reserved.runId, status: 'dispatched' } as AutomationRun
        gate.created(run)
        return run
      }
    })
    const webhooks = service
    deliver = {
      store,
      automations: () => [automation],
      bots: () => [{ id: 'bot-1' }],
      receive: (delivery, event) => webhooks.receive(delivery, event)
    }
    expect(service.advertised()).toBe(true)
    expect(service.signedOut()).toBe(false)
    server = createServer(createLocalWebhookHandler(deliver))
    const port = await listenOnLoopback(server)

    const answer = await fetch(`http://127.0.0.1:${port}/hooks/${hook.hookId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hook.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deploy: 'done' })
    })
    const { callId } = z.object({ callId: z.string() }).parse(await answer.json())

    await expect.poll(() => started.length).toBe(1)
    expect(started[0]?.event).toMatchObject({ source: 'webhook', key: callId })
    const file = join(botFolder, 'webhook-calls', `${callId}.untrusted.json`)
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('deploy')
    expect(await store.call(callId)).toMatchObject({ state: 'started', runId: started[0]?.runId })
    const card = await service.card(hook.hookId)
    expect(card.url).toBe(`http://127.0.0.1:6790/hooks/${hook.hookId}`)
    expect(await service.reveal(hook.hookId)).toEqual({
      key: hook.key,
      url: `http://127.0.0.1:6790/hooks/${hook.hookId}/${hook.key}`
    })
  })

  it('keeps local calls not yet started in their own ledger across a switch to the cloud', async () => {
    dir = mkdtempSync(join(tmpdir(), 'local-webhooks-pipeline-'))
    let account = 'local-webhooks'
    const ledger = new WebhookHostLedger(
      dir,
      () => account,
      () => new Set()
    )
    const call = (callId: string) => ({
      callId,
      hookId: 'wh_AAAAAAAAAAAAAAAA',
      automationId: 'auto-1',
      triggerId: 'rule-1',
      occurredAt: 1,
      epoch: 0
    })
    expect(ledger.receive(call('call_AAAAAAAAAAAAAAAAAAAA'), 1)).toBe(true)
    // Signed in to Orca Cloud with local webhooks off: its ledger is written too.
    account = 'cloud-account'
    expect(ledger.receive(call('call_BBBBBBBBBBBBBBBBBBBB'), 2)).toBe(true)
    account = 'local-webhooks'
    expect(ledger.call('call_AAAAAAAAAAAAAAAAAAAA')).toMatchObject({ state: 'received' })
    expect(ledger.call('call_BBBBBBBBBBBBBBBBBBBB')).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'webhook-host.json'), 'utf8'))).toMatchObject({
      account: 'cloud-account'
    })
  })

  it("keeps the other mode's call files from the sweep", () => {
    dir = mkdtempSync(join(tmpdir(), 'local-webhooks-pipeline-'))
    let account = 'local-webhooks'
    const ledger = new WebhookHostLedger(
      dir,
      () => account,
      () => new Set()
    )
    const callId = 'call_AAAAAAAAAAAAAAAAAAAA'
    const file = join(dir, 'bot', 'webhook-calls', `${callId}.untrusted.json`)
    ledger.receive(
      {
        callId,
        hookId: 'wh_AAAAAAAAAAAAAAAA',
        automationId: 'auto-1',
        triggerId: 'rule-1',
        occurredAt: 1,
        epoch: 0
      },
      1
    )
    ledger.bind(callId, { file })
    account = 'cloud-account'
    expect(ledger.files().has(file)).toBe(true)
  })

  it('offers a local call again when local webhooks come back on', async () => {
    dir = mkdtempSync(join(tmpdir(), 'local-webhooks-pipeline-'))
    const botFolder = join(dir, 'bot')
    mkdirSync(botFolder)
    const store = new LocalWebhookStore(dir)
    const hook = await store.mint('op-1', 'auto-1', 'bot-1')
    const automation = webhookAutomation(hook)
    const local = await store.hook(hook.hookId)
    const call =
      local &&
      (await store.admit(
        local,
        { receivedAt: 1, state: 'queued' },
        {
          receivedAt: 1,
          contentType: null,
          headers: {},
          body: { kind: 'text', value: '' },
          truncated: false
        }
      ))
    if (!call || call === 'queue_full') {
      throw new Error('not taken')
    }
    await store.handOverQueued(call.callId, () => true)
    // Handed over and taken by the local ledger, then local webhooks went off before it was offered.
    new WebhookHostLedger(
      dir,
      () => 'local-webhooks',
      () => new Set()
    ).receive(
      {
        callId: call.callId,
        hookId: hook.hookId,
        automationId: automation.id,
        triggerId: webhookRuleId(hook.hookId),
        occurredAt: 1,
        epoch: hook.epoch
      },
      1
    )
    let on = false
    const routes = localWebhookCalls({
      store,
      baseUrl: () => 'http://127.0.0.1:6790',
      deliver: async () => {}
    })
    const started: string[] = []
    service = new WebhookHostService({
      userDataPath: dir,
      account: () => (on ? 'local-webhooks' : 'cloud-account'),
      cloud: () => null,
      local: () => (on ? routes : null),
      automations: {
        list: () => [automation],
        runs: () => [],
        setTriggers: () => {},
        remove: () => {}
      },
      botFolder: () => botFolder,
      botFolders: () => [botFolder],
      botExists: () => true,
      newerAgentBotIds: () => new Set(),
      bot: () => undefined,
      notifyOwner: () => {},
      runForEvent: async (_id, _event, gate) => {
        const reserved = await gate.reserve(automation)
        if (!('runId' in reserved)) {
          return null
        }
        started.push(reserved.runId)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the webhook pipeline reads only a run's id, status and error.
        const run = { id: reserved.runId, status: 'dispatched' } as AutomationRun
        gate.created(run)
        return run
      }
    })
    await service.start()
    expect(started).toHaveLength(0)
    on = true
    service.modeChanged()
    await expect.poll(() => started.length).toBe(1)
  })

  it("keeps a card's answer out of the ledger when local webhooks switched meanwhile", async () => {
    dir = mkdtempSync(join(tmpdir(), 'local-webhooks-pipeline-'))
    const store = new LocalWebhookStore(dir)
    const hook = await store.mint('op-1', 'auto-1', 'bot-1')
    const automation = webhookAutomation(hook)
    const routes = localWebhookCalls({
      store,
      baseUrl: () => 'http://127.0.0.1:6790',
      deliver: async () => {}
    })
    let account = 'local-webhooks'
    const get = routes.get
    // Local webhooks go off, signed in to Orca Cloud, while the local answer is on its way.
    routes.get = (hookId) =>
      get(hookId)?.then((answer) => {
        account = 'cloud-account'
        return answer
      }) ?? null
    service = new WebhookHostService({
      userDataPath: dir,
      account: () => account,
      cloud: () => null,
      local: () => routes,
      automations: {
        list: () => [automation],
        runs: () => [],
        setTriggers: () => {},
        remove: () => {}
      },
      botFolder: () => null,
      botFolders: () => [],
      botExists: () => true,
      newerAgentBotIds: () => new Set(),
      bot: () => undefined,
      notifyOwner: () => {},
      runForEvent: async () => null
    })
    await service.card(hook.hookId)
    const ledger = new WebhookHostLedger(
      dir,
      () => 'cloud-account',
      () => new Set()
    )
    expect(ledger.hook(hook.hookId)).toBeUndefined()
  })
})
