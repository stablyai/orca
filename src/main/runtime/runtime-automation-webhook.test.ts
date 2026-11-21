import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EVENT_ONLY_SCHEDULE,
  isWebhookTrigger,
  type AutomationEventTrigger,
  type AutomationWebhookTrigger
} from '../../shared/automation-event-triggers'
import type { AutomationBotTarget } from '../../shared/automations/automation-definition'
import { webhookRuleId } from '../../shared/connector-webhook-contract'
import { removeTreeSync } from '../../shared/file-write/windows-transient-lock-removal'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { makeTestBot } from '../bots/bot.test-fixture'
import type { AutomationWebhooks } from '../webhooks/webhook-host-service'
import { RuntimeAutomationController } from './integrations/automations/runtime-automation-controller'
import type { RuntimeAutomationCreateInput } from './integrations/automations/runtime-automation-run-context'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
const bot: AutomationBotTarget = { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }
const draft: AutomationWebhookTrigger = {
  id: '',
  source: 'webhook',
  event: 'call',
  rev: 0,
  where: [{ path: 'body.action', op: '=', values: ['opened'] }]
}
const create: RuntimeAutomationCreateInput = {
  name: 'Investigate',
  prompt: 'Look into it',
  agentId: 'codex',
  timezone: 'UTC',
  bot,
  on: [draft],
  ...EVENT_ONLY_SCHEDULE
}

async function setup(advertised = true) {
  const store = await createStore()
  const group = store.createProjectGroup({
    name: 'Scout',
    createdFrom: 'manual',
    parentPath: '/bots/scout'
  })
  const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Scout' })
  store.saveBot(makeTestBot({ folderWorkspaceId: workspace.id }))
  const controller = new RuntimeAutomationController(store, {
    showRepo: vi.fn(),
    showManagedWorktree: vi.fn()
  })
  const settle = vi.fn<AutomationWebhooks['settle']>(async ({ next }) => ({
    on: next.map((trigger: AutomationEventTrigger) =>
      isWebhookTrigger(trigger) && !trigger.id
        ? { ...trigger, id: webhookRuleId(HOOK), rev: 1 }
        : trigger
    ),
    operationId: next.some((trigger) => isWebhookTrigger(trigger) && !trigger.id)
      ? 'op-1'
      : undefined
  }))
  const webhooks = {
    advertised: () => advertised,
    signedOut: () => false,
    settle,
    saved: vi.fn(),
    abandoned: vi.fn()
  }
  controller.webhooks.set(webhooks)
  return { store, controller, webhooks }
}

describe('an automation with a webhook', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-webhook-automation-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    removeTreeSync(testState.dir)
  })

  it('makes its hook for the automation it saves, then settles the make', async () => {
    const { controller, webhooks } = await setup()
    const automation = await controller.create(create)
    const asked = webhooks.settle.mock.calls[0]?.[0]
    expect(asked).toMatchObject({ botId: 'bot-1', next: [draft] })
    expect(asked?.current).toBeUndefined()
    // The hook was made for this automation's id.
    expect(automation.id).toBe(asked?.automationId)
    expect(automation.on).toEqual([{ ...draft, id: webhookRuleId(HOOK), rev: 1 }])
    expect(webhooks.saved).toHaveBeenCalledWith('op-1')
  })

  it('gives the hook up when the save fails after the make', async () => {
    const { controller, webhooks } = await setup()
    // Each emoji takes four UTF-8 bytes, so the filters exceed the hello's rule limit.
    const where = Array.from({ length: 8 }, (_, index) => ({
      path: `body.f${index}`,
      op: 'in' as const,
      values: ['😀'.repeat(40), '🚀'.repeat(40)]
    }))
    await expect(controller.create({ ...create, on: [{ ...draft, where }] })).rejects.toThrow(
      "This hook's filters are too long"
    )
    expect(webhooks.abandoned).toHaveBeenCalledWith('op-1')
    expect(webhooks.saved).not.toHaveBeenCalled()
  })

  it('keeps the hook through an edit, and refuses a cloud that takes no webhooks', async () => {
    const { controller, webhooks } = await setup()
    const automation = await controller.create(create)
    await controller.update(automation.id, { on: [{ ...draft, textContains: 'deploy' }] })
    expect(webhooks.settle.mock.calls[1]?.[0]).toMatchObject({
      automationId: automation.id,
      current: { id: automation.id }
    })
    await expect(
      controller.update(automation.id, { on: [{ ...draft, pick: ['body.__proto__.x'] }] })
    ).rejects.toThrow(`"body.__proto__.x" isn't a path`)

    const off = await setup(false)
    await expect(off.controller.create(create)).rejects.toThrow(
      "Orca Cloud doesn't support webhooks yet"
    )
    expect(off.webhooks.settle).not.toHaveBeenCalled()
  })
})
