import { homedir } from 'node:os'
import { expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StatusBarItem } from '../../../shared/ui-chrome-types'
import { normalizeLoadedUiState } from './normalize-loaded-ui-state'

const DEFAULT_ON_FLAGS = [
  '_portsStatusBarDefaultAdded',
  '_kimiStatusBarDefaultAdded',
  '_minimaxStatusBarDefaultAdded',
  '_antigravityStatusBarDefaultAdded',
  '_grokStatusBarDefaultAdded',
  '_cursorStatusBarDefaultAdded',
  '_zcodeStatusBarDefaultAdded',
  '_museStatusBarDefaultAdded'
] as const

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

it('leaves Muse off when the profile already recorded that the default was applied', () => {
  const hidden = getDefaultPersistedState(homedir()).ui.statusBarItems.filter(
    (item) => item !== 'muse'
  )
  const flags = Object.fromEntries(DEFAULT_ON_FLAGS.map((flag) => [flag, true]))
  const ui = loadUi({ statusBarItems: hidden, ...flags })

  expect(ui.statusBarItems).not.toContain('muse')
  expect(ui._museStatusBarDefaultAdded).toBe(true)
})
