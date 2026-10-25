import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeTestStores,
  createStore,
  testState,
  readPersistedStateJson
} from './persistence-test-harness'
import type { Repo } from '../../shared/repo-types'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))
const makeRepo = (): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1
})
describe('webhook persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-webhook-store-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })
  it('persists and normalizes a webhook trigger config', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const automation = store.createAutomation({
      name: 'MR review',
      prompt: 'Review the merge request',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime(),
      webhook: { enabled: true, secretMode: 'token', secret: '  s3cret  ' }
    })

    expect(automation.webhook).toEqual({ enabled: true, secretMode: 'token', secret: 's3cret' })

    // A 'none' mode update drops the secret.
    const cleared = store.updateAutomation(automation.id, {
      webhook: { enabled: true, secretMode: 'none', secret: 'ignored' }
    })
    expect(cleared.webhook).toEqual({ enabled: true, secretMode: 'none', secret: null })
    await store.flushPendingOrThrowAsync()
    const persisted = JSON.parse(readPersistedStateJson(join(testState.dir, 'orca-data.json'))) as {
      automations: { webhook: { secret: string | null } }[]
    }
    expect(persisted.automations[0].webhook.secret).toBeNull()
  })

  it('stores the captured webhook delivery on a webhook-triggered run', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'MR review',
      prompt: 'Review the merge request',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-13T00:00:00Z').getTime(),
      webhook: { enabled: true, secretMode: 'none', secret: null }
    })

    const run = store.createAutomationRun(automation, Date.now(), 'webhook', {
      body: '{"object_kind":"merge_request"}',
      contentType: 'application/json',
      truncated: false,
      receivedAt: 123
    })

    const second = store.createAutomationRun(automation, run.scheduledFor, 'webhook', {
      body: 'second delivery',
      contentType: null,
      truncated: false,
      receivedAt: 124
    })
    expect(second.id).not.toBe(run.id)
    expect(second.webhookDelivery?.body).toBe('second delivery')
    expect(run.trigger).toBe('webhook')
    expect(run.webhookDelivery?.body).toBe('{"object_kind":"merge_request"}')
  })
})
