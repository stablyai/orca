import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { normalizeLoadedGlobalSettings } from './normalize-loaded-global-settings'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'

// orca-data.json can be hand-edited or written by an older build, and this icon reaches an <img src>
// and an inline color style, so loading re-validates it the way repo hydration re-validates a
// project's own icon.
function loadProfile(overrides: Record<string, unknown>): PersistedState['settings'] {
  const defaults = getDefaultPersistedState(homedir())
  const settings: Partial<GlobalSettings> = { ...defaults.settings, ...overrides }
  const parsed: PersistedState = { ...defaults, settings: settings as GlobalSettings }
  const noop = (): void => {}
  return normalizeLoadedGlobalSettings(
    parsed,
    prepareLoadedTerminalSettings(parsed, noop),
    prepareLoadedProfileSettings(parsed, defaults, noop)
  )
}

describe('loaded default project icon', () => {
  it('keeps a supported icon and color', () => {
    const settings = loadProfile({
      defaultProjectIcon: { type: 'lucide', name: 'Folder' },
      defaultProjectIconColor: '#E11D48'
    })

    expect(settings.defaultProjectIcon).toEqual({ type: 'lucide', name: 'Folder' })
    expect(settings.defaultProjectIconColor).toBe('#e11d48')
  })

  it('defaults to the GitHub owner avatar when nothing is stored', () => {
    expect(loadProfile({}).defaultProjectIcon).toBeNull()
  })

  it('drops an unsupported icon', () => {
    expect(
      loadProfile({
        defaultProjectIcon: { type: 'image', src: 'http://internal/evil.png', source: 'github' }
      }).defaultProjectIcon
    ).toBeNull()
  })

  it('overwrites a color that is not a hex value instead of passing it through', () => {
    expect(
      loadProfile({ defaultProjectIconColor: 'url(#x)' }).defaultProjectIconColor
    ).toBeUndefined()
  })
})
