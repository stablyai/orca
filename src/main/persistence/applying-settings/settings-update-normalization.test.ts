import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { MACHINE_NAME_MAX_LENGTH } from '../../../shared/machine-name'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function settingsOperations(settings: Partial<GlobalSettings>): SettingsMutationOperations {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests only write the supplied settings; repos is the only other state field the boundary reads.
    state: { settings, repos: [] } as unknown as PersistedState,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

describe('updateSettings machineName', () => {
  it('stores the trimmed, bounded form of a written name', () => {
    const operations = settingsOperations({ machineName: '' })

    expect(updateSettings(operations, { machineName: '  Build server  ' }).machineName).toBe(
      'Build server'
    )
    expect(
      updateSettings(operations, { machineName: 'x'.repeat(MACHINE_NAME_MAX_LENGTH + 20) })
        .machineName
    ).toHaveLength(MACHINE_NAME_MAX_LENGTH)
  })

  it('stores a blank or non-string write as automatic detection', () => {
    const operations = settingsOperations({ machineName: '' })
    updateSettings(operations, { machineName: 'desk' })

    expect(updateSettings(operations, { machineName: '   ' }).machineName).toBe('')
    updateSettings(operations, { machineName: 'desk' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a hand-built client can send any JSON; the boundary must coerce it.
    expect(updateSettings(operations, { machineName: 42 as unknown as string }).machineName).toBe(
      ''
    )
  })

  it('reports the normalized name to listeners, not the raw write', () => {
    const operations = settingsOperations({ machineName: '' })

    updateSettings(operations, { machineName: '  QA desk  ' }, { notifyListeners: true })

    expect(operations.notifySettingsChanged).toHaveBeenCalledWith(
      { machineName: 'QA desk' },
      undefined
    )
  })
})

describe('updateSettings terminalDefaultShell', () => {
  it('stores a padded write trimmed and a whitespace-only write as the system shell', () => {
    const operations = settingsOperations({ terminalDefaultShell: '' })

    expect(
      updateSettings(operations, { terminalDefaultShell: '/bin/zsh ' }).terminalDefaultShell
    ).toBe('/bin/zsh')
    expect(updateSettings(operations, { terminalDefaultShell: '  ' }).terminalDefaultShell).toBe('')
  })
})

describe('updateSettings terminalMinimumContrastRatio', () => {
  it('persists an in-range floor unchanged', () => {
    const operations = settingsOperations({ terminalFontSize: 14 })

    expect(
      updateSettings(operations, { terminalMinimumContrastRatio: 1 }).terminalMinimumContrastRatio
    ).toBe(1)
    expect(
      updateSettings(operations, { terminalMinimumContrastRatio: 4.5 }).terminalMinimumContrastRatio
    ).toBe(4.5)
  })

  it('clamps a hand-edited value into xterm range', () => {
    const operations = settingsOperations({ terminalFontSize: 14 })

    expect(
      updateSettings(operations, { terminalMinimumContrastRatio: 0 }).terminalMinimumContrastRatio
    ).toBe(1)
    expect(
      updateSettings(operations, { terminalMinimumContrastRatio: 500 }).terminalMinimumContrastRatio
    ).toBe(21)
  })

  it('drops an unusable value back to automatic rather than storing it', () => {
    const operations = settingsOperations({ terminalFontSize: 14 })

    expect(
      updateSettings(operations, {
        terminalMinimumContrastRatio: Number.NaN
      }).terminalMinimumContrastRatio
    ).toBeUndefined()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hand-edited JSON can supply a string; this exercises the normalization boundary.
    const unusable = 'off' as unknown as number
    expect(
      updateSettings(operations, {
        terminalMinimumContrastRatio: unusable
      }).terminalMinimumContrastRatio
    ).toBeUndefined()
  })

  it('clears the override so the automatic floor comes back', () => {
    const operations = settingsOperations({ terminalFontSize: 14 })

    updateSettings(operations, { terminalMinimumContrastRatio: 1 })
    expect(
      updateSettings(operations, { terminalMinimumContrastRatio: undefined })
        .terminalMinimumContrastRatio
    ).toBeUndefined()
  })

  it('leaves a stored floor alone when an unrelated setting is written', () => {
    const operations = settingsOperations({ terminalFontSize: 14 })

    updateSettings(operations, { terminalMinimumContrastRatio: 1 })
    expect(updateSettings(operations, { terminalFontSize: 15 }).terminalMinimumContrastRatio).toBe(
      1
    )
  })
})

describe('updateSettings scoped chat defaults', () => {
  it('clears agent overrides for a shared chat permission choice from any writer', () => {
    const operations = settingsOperations({
      nativeChatPermissionMode: 'full-access',
      agentNativeChatPermissionModes: { codex: 'auto' }
    })
    expect(
      updateSettings(operations, { nativeChatPermissionMode: 'ask' }).agentNativeChatPermissionModes
    ).toEqual({})
  })

  it('retains explicit overrides from a bulk mutation or durable rollback', () => {
    const operations = settingsOperations({ nativeChatPermissionMode: 'ask' })
    expect(
      updateSettings(operations, {
        nativeChatPermissionMode: 'full-access',
        agentNativeChatPermissionModes: { codex: 'auto' }
      }).agentNativeChatPermissionModes
    ).toEqual({ codex: 'auto' })
  })
})
