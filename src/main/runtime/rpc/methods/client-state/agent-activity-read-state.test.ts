import { expect, it } from 'vitest'
import { getDefaultUIState } from '../../../../../shared/constants'
import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import { readAgentActivities, setAgentActivityRead } from './agent-activity-read-state'

it('mirrors desktop acknowledgements and applies a phone read without changing a sibling', () => {
  let ui: PersistedUIState = { ...getDefaultUIState(), acknowledgedAgentsByPaneKey: { other: 200 } }
  const subjects = [
    {
      paneKey: 'selected',
      worktreeId: 'main',
      hostId: 'local',
      latestActivityAt: 100,
      stateStartedAt: 100
    },
    {
      paneKey: 'other',
      worktreeId: 'main',
      hostId: 'local',
      latestActivityAt: 300,
      stateStartedAt: 300
    }
  ]
  const runtime = {
    getAgentActivitySubjects: () => subjects,
    getUIState: () => ui,
    updateUIState: (updates: Partial<PersistedUIState>) => {
      ui = { ...ui, ...updates }
      return ui
    }
  }
  expect(readAgentActivities(runtime).activities.map((activity) => activity.unread)).toEqual([
    true,
    true
  ])
  expect(setAgentActivityRead(runtime, { ...subjects[0], read: true }).unread).toBe(false)
  expect(ui.acknowledgedAgentsByPaneKey).toEqual({ selected: 100, other: 200 })
  expect(readAgentActivities(runtime).activities.map((activity) => activity.unread)).toEqual([
    false,
    true
  ])
  ui = { ...ui, acknowledgedAgentsByPaneKey: { ...ui.acknowledgedAgentsByPaneKey, other: 300 } }
  expect(readAgentActivities(runtime).activities.map((activity) => activity.unread)).toEqual([
    false,
    false
  ])
  expect(setAgentActivityRead(runtime, { ...subjects[0], read: false }).unread).toBe(true)
  expect(ui.acknowledgedAgentsByPaneKey).toEqual({ other: 300 })
})

it('refuses unavailable or ambiguously owned subjects without writing UI state', () => {
  const ui = getDefaultUIState()
  const subject = {
    paneKey: 'shared',
    worktreeId: 'main',
    hostId: 'local',
    latestActivityAt: 100,
    stateStartedAt: 100
  }
  let writes = 0
  const runtime = {
    getAgentActivitySubjects: () => null,
    getUIState: () => ui,
    updateUIState: () => {
      writes++
      return ui
    }
  }
  expect(readAgentActivities(runtime)).toEqual({ available: false, activities: [] })
  expect(() => setAgentActivityRead(runtime, { ...subject, read: true })).toThrow()
  const ambiguous = {
    ...runtime,
    getAgentActivitySubjects: () => [subject, { ...subject, hostId: 'runtime:other' }]
  }
  expect(readAgentActivities(ambiguous).activities).toEqual([])
  expect(() => setAgentActivityRead(ambiguous, { ...subject, read: true })).toThrow()
  expect(writes).toBe(0)
})
