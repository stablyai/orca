import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, testState, createStore } from '../persistence/persistence-test-harness'
import {
  createSettingsFence,
  createTextGenerationParamsFence
} from './text-generation-settings-fence'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/source-control/ai/generation/commit-message-host-key'
import type { GlobalSettings } from '../../shared/global-settings-types'

vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

function selectedAccountFence(store: ReturnType<typeof createStore>) {
  return createSettingsFence(
    () => store.getSettings(),
    ['activeClaudeManagedAccountId'],
    (settings) => settings.activeClaudeManagedAccountId
  )
}

describe('text-generation settings fences on the main store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-settings-fence-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('stays current across unrelated and same-value writes', () => {
    const store = createStore()
    store.updateSettings({ activeClaudeManagedAccountId: 'a' })
    const current = selectedAccountFence(store)
    const params = createTextGenerationParamsFence(
      () => store.getSettings(),
      LOCAL_COMMIT_MESSAGE_HOST_KEY,
      'branchName',
      null
    )
    store.updateSettings({ theme: store.getSettings().theme === 'dark' ? 'light' : 'dark' })
    store.updateSettings({ activeClaudeManagedAccountId: 'a' })
    expect(current()).toBe(true)
    expect(params()).toBe(true)
  })

  it('invalidates after the selected account changes and is restored between checks', () => {
    const store = createStore()
    store.updateSettings({ activeClaudeManagedAccountId: 'a' })
    const current = selectedAccountFence(store)
    store.updateSettings({ activeClaudeManagedAccountId: 'b' })
    store.updateSettings({ activeClaudeManagedAccountId: 'a' })
    expect(current()).toBe(false)
  })

  it('sees writes that skip listeners', () => {
    const store = createStore()
    const params = createTextGenerationParamsFence(
      () => store.getSettings(),
      LOCAL_COMMIT_MESSAGE_HOST_KEY,
      'branchName',
      null
    )
    const listener = vi.fn()
    store.onSettingsChanged(listener)
    store.updateSettings(
      { textGenerationSubscriptionFailoverEnabled: true },
      { notifyListeners: false }
    )
    store.updateSettings(
      { textGenerationSubscriptionFailoverEnabled: false },
      { notifyListeners: false }
    )
    expect(listener).not.toHaveBeenCalled()
    expect(params()).toBe(false)
  })

  it('falls back to value comparison for hosts without store revisions', () => {
    let settings: Pick<GlobalSettings, 'activeClaudeManagedAccountId'> = {
      activeClaudeManagedAccountId: 'a'
    }
    const current = createSettingsFence(
      () => settings,
      ['activeClaudeManagedAccountId'],
      (latest) => latest.activeClaudeManagedAccountId
    )
    settings = { ...settings }
    expect(current()).toBe(true)
    settings = { activeClaudeManagedAccountId: 'b' }
    expect(current()).toBe(false)
    settings = { activeClaudeManagedAccountId: 'a' }
    expect(current()).toBe(false)
  })
})
