import { Store } from '../loading-store/store'
import { prepareLegacyProfileState } from '../profile-state/legacy-json/profile-state-legacy-import'
import { closeTestStores, testState, dataFile } from '../persistence-test-harness'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as crypto from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof crypto>()),
  randomInt: vi.fn(() => 0)
}))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-chat-ui-launch-tip-audience-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('keeps frozen imported originals separate for each Store and prepared export', () => {
  const first = prepareLegacyProfileState(
    dataFile(),
    JSON.stringify({ settings: { experimentalNativeChat: { original: false } } })
  )
  const second = new Store({
    dataFile: dataFile(),
    serializedState: JSON.stringify({ settings: {} })
  })
  const third = new Store({
    dataFile: dataFile(),
    serializedState: JSON.stringify({ settings: { experimentalNativeChat: null } })
  })
  const input = { theme: 'dark' as const, experimentalNativeChat: true }
  second.updateSettings(input)
  expect(second.getSettings()).not.toHaveProperty('experimentalNativeChat')
  expect(JSON.parse(second.prepareProfileStateExport().json).settings).not.toHaveProperty(
    'experimentalNativeChat'
  )
  expect(JSON.parse(third.prepareProfileStateExport().json).settings).toHaveProperty(
    'experimentalNativeChat',
    null
  )
  expect(JSON.parse(first.prepared.json).settings).toHaveProperty('experimentalNativeChat', {
    original: false
  })
})
