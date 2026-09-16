import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function makeOperations(): SettingsMutationOperations {
  return {
    // Only the fields updateSettings reads; the rest of GlobalSettings is irrelevant to the clamp.
    state: { settings: { terminalFontSize: 14 }, repos: [] } as unknown as PersistedState,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

// #10754: desktop IPC, the web RPC and the CLI all reach the store through this boundary, and xterm
// throws on a non-finite minimumContrastRatio, so the clamp cannot live in the settings UI alone.
describe('updateSettings terminalMinimumContrastRatio', () => {
  it('persists an in-range floor unchanged', () => {
    const operations = makeOperations()

    expect(
      updateSettings(operations, { terminalMinimumContrastRatio: 1 }).terminalMinimumContrastRatio
    ).toBe(1)
    expect(
      updateSettings(operations, { terminalMinimumContrastRatio: 4.5 }).terminalMinimumContrastRatio
    ).toBe(4.5)
  })

  it('clamps a hand-edited value into xterm range', () => {
    const operations = makeOperations()

    expect(
      updateSettings(operations, { terminalMinimumContrastRatio: 0 }).terminalMinimumContrastRatio
    ).toBe(1)
    expect(
      updateSettings(operations, { terminalMinimumContrastRatio: 500 }).terminalMinimumContrastRatio
    ).toBe(21)
  })

  it('drops an unusable value back to automatic rather than storing it', () => {
    const operations = makeOperations()

    expect(
      updateSettings(operations, {
        terminalMinimumContrastRatio: Number.NaN
      }).terminalMinimumContrastRatio
    ).toBeUndefined()
    expect(
      updateSettings(operations, {
        terminalMinimumContrastRatio: 'off' as unknown as number
      }).terminalMinimumContrastRatio
    ).toBeUndefined()
  })

  it('clears the override so the automatic floor comes back', () => {
    const operations = makeOperations()

    updateSettings(operations, { terminalMinimumContrastRatio: 1 })
    expect(
      updateSettings(operations, { terminalMinimumContrastRatio: undefined })
        .terminalMinimumContrastRatio
    ).toBeUndefined()
  })

  it('leaves a stored floor alone when an unrelated setting is written', () => {
    const operations = makeOperations()

    updateSettings(operations, { terminalMinimumContrastRatio: 1 })
    expect(updateSettings(operations, { terminalFontSize: 15 }).terminalMinimumContrastRatio).toBe(
      1
    )
  })
})
