import { expect, it } from 'vitest'
import { publishBotSidebarViewChanges } from './client/settings/runtime-workspace-view-change-events'
import { getDefaultUIState } from '../../shared/orca-profiles/constants'
import type { PersistedUIState } from '../../shared/orca-profiles/persisted-ui-state-types'

it('tells phones to re-read bots when Bot options change, and only then', () => {
  let changed: ((ui: PersistedUIState) => void) | undefined
  const ui = getDefaultUIState()
  let notices = 0
  publishBotSidebarViewChanges(
    {
      getUI: () => ui,
      onUIChanged: (listener) => {
        changed = listener
        return () => {}
      }
    },
    () => {
      notices += 1
    }
  )
  changed!({ ...ui, sortBy: 'name' })
  expect(notices).toBe(0)
  const sorted = {
    ...ui,
    botSidebarView: { sortBy: 'recent', hidePausedBots: false, hideSleepingWorkers: false }
  } satisfies PersistedUIState
  changed!(sorted)
  changed!({ ...sorted, sortBy: 'smart' })
  expect(notices).toBe(1)
  changed!({ ...sorted, botSidebarView: { ...sorted.botSidebarView, hidePausedBots: true } })
  expect(notices).toBe(2)
})
