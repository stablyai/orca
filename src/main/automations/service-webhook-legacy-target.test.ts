import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createStore,
  testState,
  readPersistedStateJson,
  writePersistedStateJson
} from '../persistence/persistence-test-harness'
import { AutomationService } from './service'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`encrypted:${text}`),
    decryptString: (data: Buffer) => data.toString().slice('encrypted:'.length)
  }
}))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-webhook-legacy-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('captures a legacy webhook target before publishing the dispatch snapshot', async () => {
  const store = await createStore()
  store.addRepo({ id: 'r1', path: '/repo', displayName: 'test', badgeColor: '#fff', addedAt: 1 })
  const created = store.createAutomation({
    name: 'Legacy webhook',
    prompt: 'Review delivery',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: Date.now() + 86_400_000,
    webhook: { enabled: true, secretMode: 'none', secret: null }
  })
  const file = join(testState.dir, 'orca-data.json')
  const persisted = JSON.parse(readPersistedStateJson(file))
  persisted.automations[0].runContext = null
  writePersistedStateJson(file, JSON.stringify(persisted))
  const reloaded = await createStore()
  expect(reloaded.listAutomations()[0].runContext).toBeNull()
  const send = vi.fn()
  const service = new AutomationService(reloaded)
  service.setWebContents({ isDestroyed: () => false, send })
  service.setRendererReady()
  const run = await service.triggerWebhook(created.id, {
    body: '{}',
    contentType: 'application/json',
    truncated: false,
    receivedAt: Date.now()
  })
  const context = reloaded.listAutomations()[0].runContext
  expect(context).toMatchObject({ hostId: 'local', repoId: 'r1', path: '/repo' })
  expect(send).toHaveBeenCalledWith(
    'automations:dispatchRequested',
    expect.objectContaining({
      automation: expect.objectContaining({ runContext: context }),
      run: expect.objectContaining({ id: run.id, trigger: 'webhook' })
    })
  )
})
