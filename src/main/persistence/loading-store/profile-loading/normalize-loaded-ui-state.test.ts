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

it('adds Muse on a headless profile that never ran the renderer default-on step', () => {
  const legacyItems = getDefaultPersistedState(homedir()).ui.statusBarItems.filter(
    (item) => item !== 'muse' && item !== 'antigravity'
  )
  const ui = loadUi({
    statusBarItems: legacyItems,
    _portsStatusBarDefaultAdded: true,
    _kimiStatusBarDefaultAdded: true,
    _minimaxStatusBarDefaultAdded: true,
    _grokStatusBarDefaultAdded: true,
    _cursorStatusBarDefaultAdded: true,
    _zcodeStatusBarDefaultAdded: true
  })

  expect(ui.statusBarItems).toEqual([
    ...legacyItems,
    'antigravity',
    'muse'
  ] satisfies StatusBarItem[])
  expect(ui._museStatusBarDefaultAdded).toBe(true)
  expect(ui._antigravityStatusBarDefaultAdded).toBe(true)
})
