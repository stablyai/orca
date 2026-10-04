import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function makeOperations(): SettingsMutationOperations {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields updateSettings reads for this setting.
    state: { settings: {}, repos: [] } as unknown as PersistedState,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

describe('updateSettings context pressure', () => {
  it('normalizes thresholds and soft limits on every settings write', () => {
    const operations = makeOperations()

    // Percents: rounded and clamped to 1–100; non-finite falls back to the default.
    expect(
      updateSettings(operations, { contextPressureWarnPercent: 55.6 }).contextPressureWarnPercent
    ).toBe(56)
    expect(
      updateSettings(operations, { contextPressureWarnPercent: 0 }).contextPressureWarnPercent
    ).toBe(1)
    expect(
      updateSettings(operations, { contextPressureCriticalPercent: 400 })
        .contextPressureCriticalPercent
    ).toBe(100)
    expect(
      updateSettings(operations, { contextPressureWarnPercent: Number.NaN })
        .contextPressureWarnPercent
    ).toBe(70)
    expect(
      updateSettings(operations, { contextPressureCriticalPercent: 'high' as never })
        .contextPressureCriticalPercent
    ).toBe(90)

    const ordered = updateSettings(operations, {
      contextPressureWarnPercent: 95,
      contextPressureCriticalPercent: 80
    })
    expect(ordered.contextPressureWarnPercent).toBe(95)
    expect(ordered.contextPressureCriticalPercent).toBe(95)

    // Soft limits: positive finite integer caps only; junk entries dropped, non-object emptied.
    const updated = updateSettings(operations, {
      contextPressureSoftLimits: {
        'model:claude-opus-5': 400_000.9,
        'agent:codex': -1,
        'agent:gemini': Number.NaN,
        'claude-opus-5': 100_000,
        '': 5
      }
    })
    expect(updated.contextPressureSoftLimits).toEqual({ 'model:claude-opus-5': 400_000 })
    expect(
      updateSettings(operations, { contextPressureSoftLimits: 'claude=1' as never })
        .contextPressureSoftLimits
    ).toEqual({})
  })
})
