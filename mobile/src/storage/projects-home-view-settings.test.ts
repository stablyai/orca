import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PROJECTS_HOME_VIEW_SETTINGS,
  parseProjectsHomeViewSettings,
  saveProjectsHomeViewSettings
} from './projects-home-view-settings'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { setItem: vi.fn() }
}))

describe('parseProjectsHomeViewSettings', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.setItem).mockReset()
  })

  it('falls back to defaults for absent or unparseable records', () => {
    expect(parseProjectsHomeViewSettings(null)).toEqual(DEFAULT_PROJECTS_HOME_VIEW_SETTINGS)
    expect(parseProjectsHomeViewSettings('{oops')).toEqual(DEFAULT_PROJECTS_HOME_VIEW_SETTINGS)
    expect(parseProjectsHomeViewSettings('"a string"')).toEqual(DEFAULT_PROJECTS_HOME_VIEW_SETTINGS)
  })

  it('keeps recognised fields and defaults the rest', () => {
    const parsed = parseProjectsHomeViewSettings(
      JSON.stringify({ groupMode: 'prStatus', hideSleeping: true })
    )

    expect(parsed.groupMode).toBe('prStatus')
    expect(parsed.hideSleeping).toBe(true)
    expect(parsed.sortMode).toBe(DEFAULT_PROJECTS_HOME_VIEW_SETTINGS.sortMode)
    expect(parsed.hideDefaultBranch).toBe(false)
  })

  it('rejects modes a newer build may have written', () => {
    const parsed = parseProjectsHomeViewSettings(
      JSON.stringify({ groupMode: 'byMoonPhase', sortMode: 'entropy' })
    )

    expect(parsed.groupMode).toBe(DEFAULT_PROJECTS_HOME_VIEW_SETTINGS.groupMode)
    expect(parsed.sortMode).toBe(DEFAULT_PROJECTS_HOME_VIEW_SETTINGS.sortMode)
  })

  it('keeps scoped and legacy host filter ids while dropping invalid values', () => {
    const parsed = parseProjectsHomeViewSettings(
      JSON.stringify({
        executionHostIds: [
          'local',
          '["desktop","ssh:gpu-box"]',
          '["desktop",null]',
          '',
          42,
          'nonsense:x',
          'local'
        ]
      })
    )

    expect(parsed.executionHostIds).toEqual([
      'local',
      '["desktop","ssh:gpu-box"]',
      '["desktop",null]'
    ])
  })

  it('absorbs best-effort storage failures', async () => {
    vi.mocked(AsyncStorage.setItem).mockRejectedValue(new Error('storage unavailable'))

    await expect(
      saveProjectsHomeViewSettings(DEFAULT_PROJECTS_HOME_VIEW_SETTINGS)
    ).resolves.toBeUndefined()
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1)
  })
})
