import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { MACHINE_NAME_MAX_LENGTH } from '../../../shared/machine-name'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function makeOperations(): SettingsMutationOperations {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields updateSettings reads for this setting.
    state: { settings: { machineName: '' }, repos: [] } as unknown as PersistedState,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

// Desktop IPC, the web RPC and the CLI all reach the store through this boundary, so the name a
// runtime publishes is normalized once here rather than at each writer.
describe('updateSettings machineName', () => {
  it('stores the trimmed, bounded form of a written name', () => {
    const operations = makeOperations()

    expect(updateSettings(operations, { machineName: '  Build server  ' }).machineName).toBe(
      'Build server'
    )
    expect(
      updateSettings(operations, { machineName: 'x'.repeat(MACHINE_NAME_MAX_LENGTH + 20) })
        .machineName
    ).toHaveLength(MACHINE_NAME_MAX_LENGTH)
  })

  it('stores a blank or non-string write as automatic detection', () => {
    const operations = makeOperations()
    updateSettings(operations, { machineName: 'desk' })

    expect(updateSettings(operations, { machineName: '   ' }).machineName).toBe('')
    updateSettings(operations, { machineName: 'desk' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a hand-built client can send any JSON; the boundary must coerce it.
    expect(updateSettings(operations, { machineName: 42 as unknown as string }).machineName).toBe(
      ''
    )
  })

  it('reports the normalized name to listeners, not the raw write', () => {
    const operations = makeOperations()

    updateSettings(operations, { machineName: '  QA desk  ' }, { notifyListeners: true })

    expect(operations.notifySettingsChanged).toHaveBeenCalledWith(
      { machineName: 'QA desk' },
      undefined
    )
  })
})
