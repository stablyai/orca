import {
  closeTestStores,
  createStore,
  readPersistedState,
  testState,
  writeDataFile
} from '../persistence-test-harness'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-usage-limit-auto-continue-'))
})
afterEach(async () => {
  await closeTestStores()
  vi.resetAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('turns the old saved default on once, then keeps an explicit off through restart', async () => {
  writeDataFile({ settings: { nativeChatAutoContinueAfterUsageLimit: false } })
  const store = createStore()
  expect(store.getSettings().nativeChatAutoContinueAfterUsageLimit).toBe(true)
  store.flush()
  expect(readPersistedState().settings).toMatchObject({
    nativeChatAutoContinueAfterUsageLimit: true,
    nativeChatAutoContinueAfterUsageLimitDefaultedOn: true
  })

  store.updateSettings({ nativeChatAutoContinueAfterUsageLimit: false })
  store.flush()
  await closeTestStores()
  expect(createStore().getSettings().nativeChatAutoContinueAfterUsageLimit).toBe(false)
})
