import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeTestStores,
  createStore,
  testState,
  writeDataFile
} from '../../persistence-test-harness'
import { getDefaultPersistedState } from '../../../shared/constants'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function makeOperations(): SettingsMutationOperations {
  const state = getDefaultPersistedState(tmpdir())
  state.settings.terminalLinkActionPopoverEnabled = false
  return {
    state,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

describe('terminal URL click preference writes', () => {
  it.each(['actions', 'open', 'none'] as const)(
    'publishes the explicit %s choice with a consistent legacy switch',
    (behavior) => {
      const operations = makeOperations()
      operations.state.settings.terminalLinkActionPopoverEnabled = behavior !== 'actions'
      operations.state.settings.terminalLinkClickBehavior =
        behavior === 'actions' ? 'none' : 'actions'
      updateSettings(
        operations,
        {
          terminalLinkClickBehavior: behavior,
          terminalLinkActionPopoverEnabled: behavior !== 'actions'
        },
        { notifyListeners: true, originWebContentsId: 7 }
      )

      expect(operations.state.settings.terminalLinkClickBehavior).toBe(behavior)
      expect(operations.state.settings.terminalLinkActionPopoverEnabled).toBe(
        behavior === 'actions'
      )
      expect(operations.notifySettingsChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalLinkClickBehavior: behavior,
          terminalLinkActionPopoverEnabled: behavior === 'actions'
        }),
        7
      )
    }
  )

  it('preserves a legacy-only switch update', () => {
    const operations = makeOperations()
    updateSettings(operations, { terminalLinkActionPopoverEnabled: true })
    expect(operations.state.settings.terminalLinkActionPopoverEnabled).toBe(true)
    updateSettings(operations, { terminalLinkActionPopoverEnabled: false })
    expect(operations.state.settings.terminalLinkActionPopoverEnabled).toBe(false)
  })
})

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

describe('terminal URL click preference persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-terminal-link-preference-'))
    writeDataFile({ version: 1, settings: { terminalLinkActionPopoverEnabled: false } })
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps an old opt-out after saving unrelated settings and reopening the profile', async () => {
    const store = createStore()
    store.updateSettings({ terminalFontSize: 15 })
    store.flush()
    await closeTestStores()

    const reopened = createStore()
    expect(reopened.getSettings()).toMatchObject({
      terminalLinkClickBehavior: 'actions',
      terminalLinkActionPopoverEnabled: false,
      terminalFontSize: 15
    })
  })

  it('keeps a newly selected Actions preference after reopening the profile', async () => {
    const store = createStore()
    store.updateSettings({ terminalLinkClickBehavior: 'actions' })
    store.flush()
    await closeTestStores()

    const reopened = createStore()
    expect(reopened.getSettings()).toMatchObject({
      terminalLinkClickBehavior: 'actions',
      terminalLinkActionPopoverEnabled: true
    })
  })
})
