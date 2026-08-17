import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROJECTS_HOME_VIEW_SETTINGS,
  parseProjectsHomeViewSettings
} from './projects-home-view-settings'

describe('parseProjectsHomeViewSettings', () => {
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
})
