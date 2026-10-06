import { homedir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeLoadedUiState } from './normalize-loaded-ui-state'

it.each([undefined, false, null, 1, 'true', {}, true])(
  'persists the root migration unless the raw marker is boolean true (%j)',
  (marker) => {
    const defaults = getDefaultPersistedState(homedir())
    const onboarding = defaults.onboarding!
    const normalizedUI = normalizeLoadedUiState(
      defaults,
      defaults,
      onboarding,
      false,
      false,
      vi.fn()
    )
    const parsed: PersistedState = JSON.parse(
      JSON.stringify({
        ...defaults,
        ui: { ...normalizedUI, _explorerDisplayRootMigrated: marker },
        worktreeMeta: { existing: { sparseDirectories: ['src'] } }
      })
    )
    const markNeedsSave = vi.fn()
    const ui = normalizeLoadedUiState(parsed, defaults, onboarding, false, false, markNeedsSave)
    expect(ui._explorerDisplayRootMigrated).toBe(true)
    expect(ui.explorerDisplayRootByWorktree).toEqual(marker === true ? {} : { existing: '/' })
    expect(markNeedsSave).toHaveBeenCalledTimes(marker === true ? 0 : 1)

    markNeedsSave.mockClear()
    const reloaded = normalizeLoadedUiState(
      { ...parsed, ui },
      defaults,
      onboarding,
      false,
      false,
      markNeedsSave
    )
    expect(reloaded.explorerDisplayRootByWorktree).toEqual(ui.explorerDisplayRootByWorktree)
    expect(markNeedsSave).not.toHaveBeenCalled()
  }
)
