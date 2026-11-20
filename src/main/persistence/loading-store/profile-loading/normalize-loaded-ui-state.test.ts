import { updatePersistedUI } from '../../applying-settings/ui-state-update'
import { homedir } from 'node:os'
import { expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../../shared/orca-profiles/constants'
import { getDefaultOnboardingState } from '../../../../shared/onboarding/onboarding-defaults'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type { StatusBarItem } from '../../../../shared/ui-chrome/ui-chrome-types'
import { normalizeLoadedUiState } from './normalize-loaded-ui-state'

function loadUi(ui: Partial<PersistedState['ui']>) {
  const defaults = getDefaultPersistedState(homedir())
  const parsed: PersistedState = {
    ...defaults,
    ui: { ...defaults.ui, ...ui }
  }
  return normalizeLoadedUiState(
    parsed,
    defaults,
    getDefaultOnboardingState(),
    false,
    false,
    () => {}
  )
}

it('keeps a saved status bar removal across reloads before default migrations have run', () => {
  const state = getDefaultPersistedState(homedir())
  updatePersistedUI(
    {
      state,
      removeRetainedBlob: () => {},
      setActiveView: () => false,
      getUI: () => state.ui,
      scheduleSave: () => {},
      notifyUIChanged: () => {}
    },
    { statusBarItems: ['ssh'] }
  )
  const ui = loadUi(state.ui)
  expect(ui.statusBarItems).toEqual(['ssh'] satisfies StatusBarItem[])
  expect(loadUi(ui).statusBarItems).toEqual(['ssh'] satisfies StatusBarItem[])
})
