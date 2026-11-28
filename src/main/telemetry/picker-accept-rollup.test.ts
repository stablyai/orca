import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { Store } from '../persistence/loading-store/store'
import { flushPickerAccepts, rollUpPickerAccept } from './picker-accept-rollup'

const DAY = 86_400_000

function fakeStore(): Pick<Store, 'getSettings' | 'updateSettings'> {
  let settings: GlobalSettings = {
    ...getDefaultSettings('/home'),
    telemetry: { optedIn: true, installId: 'i', existedBeforeTelemetryRelease: false }
  }
  return {
    getSettings: () => settings,
    updateSettings: (patch) => {
      settings = { ...settings, ...patch }
      return settings
    }
  }
}

describe('picker accept rollup', () => {
  it('sends each finished day once, as one row per agent and kind', () => {
    const store = fakeStore()
    const sent: unknown[] = []
    const emit = (_name: string, row: unknown) => sent.push(row) > 0
    const day = 20_000 * DAY
    rollUpPickerAccept({ agent_kind: 'claude-code', item_kind: 'command' }, day + 1, store, emit)
    rollUpPickerAccept({ agent_kind: 'claude-code', item_kind: 'command' }, day + 2, store, emit)
    rollUpPickerAccept({ agent_kind: 'codex', item_kind: 'skill' }, day + 3, store, emit)
    flushPickerAccepts(day + 4, store, emit)
    expect(sent).toEqual([])

    flushPickerAccepts(day + DAY, store, emit)
    flushPickerAccepts(day + DAY + 1, store, emit)
    rollUpPickerAccept({ agent_kind: 'codex', item_kind: 'skill' }, day + DAY + 2, store, emit)
    expect(sent).toEqual([
      { agent_kind: 'claude-code', item_kind: 'command', accept_count: 2, usage_day: '2024-10-04' },
      { agent_kind: 'codex', item_kind: 'skill', accept_count: 1, usage_day: '2024-10-04' }
    ])

    // Sharing turned back on: days up to then may hold activity from while it was off.
    const telemetry = store.getSettings().telemetry
    store.updateSettings({
      telemetry: telemetry && { ...telemetry, sharingResumedDay: '2024-10-05' }
    })
    flushPickerAccepts(day + 2 * DAY, store, emit)
    expect(sent).toHaveLength(2)
  })
})
