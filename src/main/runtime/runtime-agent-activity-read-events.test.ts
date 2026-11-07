import { expect, it } from 'vitest'
import { publishAgentActivityReadChanges } from './runtime-agent-activity-read-events'
import { getDefaultUIState } from '../../shared/constants'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'

it('publishes desktop read/unread changes without emitting on unrelated UI preferences', () => {
  let changed!: (ui: PersistedUIState) => void
  const events: unknown[] = []
  const initial = getDefaultUIState()
  publishAgentActivityReadChanges(
    {
      getUI: () => initial,
      onUIChanged: (listener) => {
        changed = listener
        return () => {}
      }
    },
    (event) => {
      events.push(event)
    }
  )
  changed({ ...initial, acknowledgedAgentsByPaneKey: {} })
  expect(events).toEqual([])
  changed({ ...initial, acknowledgedAgentsByPaneKey: { pane: 123 } })
  changed({ ...initial, manuallyUnreadTurnsByPaneKey: { pane: 100 } })
  expect(events).toEqual([
    { type: 'agentActivityReadStateChanged' },
    { type: 'agentActivityReadStateChanged' }
  ])
})
