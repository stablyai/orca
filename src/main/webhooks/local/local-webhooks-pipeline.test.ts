import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import type { AutomationRunEvent } from '../../../shared/automation-event-triggers'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { WebhookHostService } from '../webhook-host-service'
import { deliverLocalCall } from './local-webhook-delivery'
import { createLocalWebhookHandler } from './local-webhook-listener'
import { localWebhookCalls } from './local-webhook-routes'
import { LocalWebhookStore } from './local-webhook-store'
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
})
