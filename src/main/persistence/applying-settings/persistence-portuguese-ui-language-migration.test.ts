import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeTestStores,
  createStore,
  readPersistedStateJson,
  testState,
  writeDataFile
} from '../persistence-test-harness'

const plugin = 'plugin:stablyai.orca-portuguese/pt-BR'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-portuguese-'))
})
afterEach(async () => {
  vi.useRealTimers()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('Portuguese profile migration durability', () => {
  it.each([plugin, 'en'])(
    'schedules a durable marker when only that marker is missing: %s',
    async (language) => {
      writeDataFile({ settings: {} })
      const initial = createStore()
      initial.flush()
      await initial.waitForPendingWrite()
      await closeTestStores()
      const settled = JSON.parse(readPersistedStateJson())
      settled.settings.uiLanguage = language
      delete settled.settings.uiLanguagePortugueseMigrationApplied
      writeDataFile(settled)

      vi.useFakeTimers()
      const loaded = createStore()
      vi.advanceTimersByTime(5000)
      await loaded.waitForPendingWrite()
      const expected = language === plugin ? 'pt' : language
      expect(JSON.parse(readPersistedStateJson()).settings).toMatchObject({
        uiLanguage: expected,
        uiLanguagePortugueseMigrationApplied: true
      })
      await closeTestStores()
      const reopened = createStore()
      expect(reopened.getSettings()).toMatchObject({
        uiLanguage: expected,
        uiLanguagePortugueseMigrationApplied: true
      })
      reopened.updateSettings({ uiLanguage: plugin })
      reopened.updateSettings({ terminalFontSize: 18 })
      vi.advanceTimersByTime(5000)
      await reopened.waitForPendingWrite()
      await closeTestStores()
      expect(createStore().getSettings()).toMatchObject({
        uiLanguage: plugin,
        uiLanguagePortugueseMigrationApplied: true,
        terminalFontSize: 18
      })
    }
  )

  it('keeps a fresh profile plugin selection through unrelated updates and reopen', async () => {
    const fresh = createStore()
    expect(fresh.getSettings().uiLanguagePortugueseMigrationApplied).toBe(true)
    fresh.updateSettings({ uiLanguage: plugin })
    fresh.updateSettings({ terminalFontSize: 17 })
    vi.useFakeTimers()
    fresh.flush()
    await fresh.waitForPendingWrite()
    await closeTestStores()
    expect(createStore().getSettings()).toMatchObject({
      uiLanguage: plugin,
      uiLanguagePortugueseMigrationApplied: true,
      terminalFontSize: 17
    })
  })
})
