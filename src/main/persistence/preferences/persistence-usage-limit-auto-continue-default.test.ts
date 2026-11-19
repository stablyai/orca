import {
  closeTestStores,
  createStore,
  readPersistedState,
  testState,
  writeDataFile
} from '../persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

async function reopened() {
  await closeTestStores()
  return createStore().getSettings().nativeChatAutoContinueAfterUsageLimit
}

describe('continuing chats after a usage limit, on by default', () => {
  it('is on for a new profile', async () => {
    expect(createStore().getSettings().nativeChatAutoContinueAfterUsageLimit).toBe(true)
  })

  it('turns on once for a profile that saved the old default off', async () => {
    writeDataFile({ settings: { nativeChatAutoContinueAfterUsageLimit: false } })
    const store = createStore()
    expect(store.getSettings().nativeChatAutoContinueAfterUsageLimit).toBe(true)
    store.flush()
    expect(readPersistedState().settings).toMatchObject({
      nativeChatAutoContinueAfterUsageLimit: true,
      nativeChatAutoContinueAfterUsageLimitDefaultedOn: true
    })
  })

  it('keeps an explicit off through restart', async () => {
    const store = createStore()
    store.updateSettings({ nativeChatAutoContinueAfterUsageLimit: false })
    store.flush()
    expect(await reopened()).toBe(false)
  })

  it('keeps an off saved after the rollout', async () => {
    writeDataFile({
      settings: {
        nativeChatAutoContinueAfterUsageLimit: false,
        nativeChatAutoContinueAfterUsageLimitDefaultedOn: true
      }
    })
    expect(createStore().getSettings().nativeChatAutoContinueAfterUsageLimit).toBe(false)
  })

  it('keeps an off chosen right after the one-time flip', async () => {
    writeDataFile({ settings: { nativeChatAutoContinueAfterUsageLimit: false } })
    const store = createStore()
    store.updateSettings({ nativeChatAutoContinueAfterUsageLimit: false })
    store.flush()
    expect(await reopened()).toBe(false)
  })
})
