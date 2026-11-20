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

it.each([undefined, true])('keeps Kimi removed across reloads with migration flag %s', (flag) => {
  const ui = loadUi({ statusBarItems: ['ssh'], _kimiStatusBarDefaultAdded: flag })
  expect(ui.statusBarItems).toEqual([
    'ssh',
    'ports',
    'minimax',
    'antigravity',
    'grok',
    'cursor',
    'zcode',
    'muse',
    'git-blame'
  ] satisfies StatusBarItem[])
  expect(loadUi(ui).statusBarItems).toEqual([
    'ssh',
    'ports',
    'minimax',
    'antigravity',
    'grok',
    'cursor',
    'zcode',
    'muse',
    'git-blame'
  ] satisfies StatusBarItem[])
})
