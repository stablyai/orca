import { closeTestStores, testState, createStore, readDataFile } from './persistence-test-harness'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-chat-appearance-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('normalizes, saves, reloads, and removes chat appearance overrides', async () => {
  const store = await createStore()
  store.updateSettings({ nativeChatAppearance: { fontSize: 25, codeFontSize: 15, width: 'wide' } })
  store.flush()
  expect(readDataFile()).toHaveProperty('settings.nativeChatAppearance', {
    fontSize: 20,
    codeFontSize: 15,
    width: 'wide'
  })
  await closeTestStores()
  const reopened = await createStore()
  expect(reopened.getSettings().nativeChatAppearance).toEqual({
    fontSize: 20,
    codeFontSize: 15,
    width: 'wide'
  })
  reopened.updateSettings({
    nativeChatAppearance: { fontSize: 14, codeFontSize: 12, width: 'comfortable' }
  })
  reopened.flush()
  expect(readDataFile()).not.toHaveProperty('settings.nativeChatAppearance')
  reopened.updateSettings({ nativeChatAppearance: { fontSize: 16 } })
  reopened.updateSettings({ nativeChatAppearance: undefined })
  reopened.flush()
  expect(readDataFile()).not.toHaveProperty('settings.nativeChatAppearance')
})
