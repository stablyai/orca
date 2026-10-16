import { homedir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeLoadedUiState } from './normalize-loaded-ui-state'

it('schedules a save when leftover agent-filter keys remain beside filterAgentIds', () => {
  const defaults = getDefaultPersistedState(homedir())
  const onboarding = defaults.onboarding!
  const parsed: PersistedState = {
    ...defaults,
    ui: {
      ...defaults.ui,
      filterAgentIds: ['codex'],
      filterAgentId: 'openclaude',
      filterHarnessId: 'cc'
    }
  }
  const markNeedsSave = vi.fn()
  const ui = normalizeLoadedUiState(parsed, defaults, onboarding, false, false, markNeedsSave)

  expect(ui.filterAgentIds).toEqual(['codex'])
  expect(ui).not.toHaveProperty('filterAgentId')
  expect(ui).not.toHaveProperty('filterHarnessId')
  expect(markNeedsSave).toHaveBeenCalled()
})
