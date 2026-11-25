// automation.update's write-time guard (`unchangedSince`): a save checked against what the editor
// read refuses once the record moved on, even while its bot's places resolve.
import './rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutomationBotTarget } from '../../shared/automations/automation-definition'
import { removeTreeSync } from '../../shared/file-write/windows-transient-lock-removal'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { makeTestBot } from '../bots/bot.test-fixture'
import { RpcDispatcher } from './rpc/dispatcher'
import { AUTOMATION_METHODS } from './rpc/methods/automations/automations'
import type { OrcaRuntimeService } from './orca-runtime'
import { RuntimeAutomationController } from './integrations/automations/runtime-automation-controller'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const botTarget: AutomationBotTarget = { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }

const schedule = {
  name: 'Morning digest',
  prompt: 'Summarize the night',
  agentId: 'codex',
  timezone: 'UTC',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: 1
} as const

async function setup() {
  const store = await createStore()
  store.addRepo({
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '#fff',
    addedAt: 1
  })
  const group = store.createProjectGroup({
    name: 'Reviewer',
    createdFrom: 'manual',
    parentPath: '/bots/reviewer'
  })
  const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Reviewer' })
  store.saveBot(
    makeTestBot({ folderWorkspaceId: workspace.id, slack: { appId: 'A1', teamId: 'T1' } })
  )
  const resolvers = {
    showRepo: vi.fn(async () => store.getRepos()[0]!),
    showManagedWorktree: vi.fn(async () => {
      throw new Error('a bot automation must not look up a worktree')
    })
  }
  return {
    store,
    folderKey: `folder:${workspace.id}`,
    resolvers,
    controller: new RuntimeAutomationController(store, resolvers)
  }
}

describe('automation.update with unchangedSince', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-update-guard-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    removeTreeSync(testState.dir)
  })

  it('refuses a guarded RPC save when results change while places are resolving', async () => {
    const { controller, store } = await setup()
    const created = await controller.create({ ...schedule, bot: botTarget })
    controller.placeRefs = () => async () => {
      store.updateAutomation(created.id, { bot: { ...botTarget, resultsTo: 'none' } })
      return { ref: 'slack:T1:C0RES', label: '#results', key: 'C0RES' }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This RPC only uses the runtime ID and automation update.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateAutomation: controller.update.bind(controller)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
    const response = await dispatcher.dispatch({
      id: 'guarded-save',
      authToken: 'tok',
      method: 'automation.update',
      params: {
        id: created.id,
        updates: {
          name: 'Must not save',
          bot: { ...botTarget, resultsTo: { channel: '#results' } }
        },
        unchangedSince: { on: created.on, bot: created.bot }
      }
    })
    expect(response).toMatchObject({ ok: false, error: { message: 'automation_changed' } })
    expect(controller.show(created.id)).toMatchObject({
      name: 'Morning digest',
      bot: { resultsTo: 'none' }
    })
  })

  it('refuses a guarded RPC save after the schedule changes', async () => {
    const { controller } = await setup()
    const created = await controller.create({ ...schedule, bot: botTarget })
    await controller.update(created.id, { rrule: 'FREQ=HOURLY' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This RPC only uses the runtime ID and automation update.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateAutomation: controller.update.bind(controller)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: AUTOMATION_METHODS })
    const response = await dispatcher.dispatch({
      id: 'guarded-schedule',
      authToken: 'tok',
      method: 'automation.update',
      params: {
        id: created.id,
        updates: { rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0' },
        unchangedSince: {
          on: created.on,
          bot: created.bot,
          schedule: {
            rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
            dtstart: 1,
            timezone: 'UTC'
          }
        }
      }
    })
    expect(response).toMatchObject({ ok: false, error: { message: 'automation_changed' } })
    expect(controller.show(created.id).rrule).toBe('FREQ=HOURLY')
  })
})
