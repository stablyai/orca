import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import {
  closeTestStores,
  createStore,
  readPersistedState,
  testState,
  writeDataFile
} from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

const TELEMETRY = { optedIn: true, installId: 'install-1', existedBeforeTelemetryRelease: false }

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-link-open-mode-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function loadThenReload(): Promise<{
  first: ReturnType<ReturnType<typeof createStore>['getSettings']>
  reloaded: ReturnType<ReturnType<typeof createStore>['getSettings']>
}> {
  const store = createStore()
  const first = store.getSettings()
  store.flush()
  await closeTestStores()
  const reloaded = createStore().getSettings()
  return { first, reloaded }
}

describe('link-open mode on first load', () => {
  it('opens links directly for a profile with no saved state, through a reload', async () => {
    const { first, reloaded } = await loadThenReload()
    expect(first.httpLinkClickBehavior).toBe('open')
    expect(first.openLinksInAppPreferencePrompted).toBe(true)
    expect(reloaded.httpLinkClickBehavior).toBe('open')
  })

  it('treats a telemetry-only secondary profile as new and keeps its telemetry', async () => {
    writeDataFile({ settings: { telemetry: TELEMETRY } })
    const { first } = await loadThenReload()
    expect(first.httpLinkClickBehavior).toBe('open')
    expect(first.telemetry).toMatchObject(TELEMETRY)
  })

  it('keeps an existing profile on the default Actions popover asking', async () => {
    writeDataFile(getDefaultPersistedState('/Users/tester'))
    const { first, reloaded } = await loadThenReload()
    expect(first.httpLinkClickBehavior).toBe('ask')
    expect(first.openLinksInAppPreferencePrompted).toBe(false)
    expect(reloaded.httpLinkClickBehavior).toBe('ask')
  })

  it.each([
    [{ terminalLinkClickBehavior: 'open' }, 'open'],
    [{ terminalLinkClickBehavior: 'none' }, 'open'],
    [{ terminalLinkClickBehavior: undefined, terminalLinkActionPopoverEnabled: false }, 'open'],
    [{ terminalLinkClickBehavior: 'actions', openLinksInApp: true }, 'ask']
  ])('derives an existing profile from its terminal choice %o', async (saved, expected) => {
    const defaults = getDefaultPersistedState('/Users/tester')
    writeDataFile({ ...defaults, settings: { ...defaults.settings, ...saved } })
    const { first } = await loadThenReload()
    expect(first.httpLinkClickBehavior).toBe(expected)
  })

  it('keeps a valid saved mode and the saved browser over the terminal choice', async () => {
    const defaults = getDefaultPersistedState('/Users/tester')
    writeDataFile({
      ...defaults,
      settings: {
        ...defaults.settings,
        httpLinkClickBehavior: 'open',
        openLinksInApp: true,
        terminalLinkClickBehavior: 'actions'
      }
    })
    const { first } = await loadThenReload()
    expect(first.httpLinkClickBehavior).toBe('open')
    expect(first.openLinksInApp).toBe(true)
  })

  it('replaces an invalid stored mode with the derived one and persists it', async () => {
    const defaults = getDefaultPersistedState('/Users/tester')
    writeDataFile({
      ...defaults,
      settings: { ...defaults.settings, httpLinkClickBehavior: 'sometimes' }
    })
    await loadThenReload()
    expect(readPersistedState().settings.httpLinkClickBehavior).toBe('ask')
  })

  it('drops an invalid mode written later instead of shadowing the stored one', () => {
    const store = createStore()
    store.updateSettings({ httpLinkClickBehavior: 'ask' })
    const invalid: Partial<GlobalSettings> = JSON.parse('{"httpLinkClickBehavior":"sometimes"}')
    store.updateSettings(invalid)
    expect(store.getSettings().httpLinkClickBehavior).toBe('ask')
  })
})
