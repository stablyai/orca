import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { normalizeAgentLaunchProfiles } from '../../../shared/agent-launch-profile'
import { updateSettings, type SettingsMutationOperations } from './settings-update'

function makeOperations(): SettingsMutationOperations {
  return {
    state: getDefaultPersistedState('/tmp/orca-profile-home'),
    bumpLocalWorktreeScanGeneration: vi.fn(),
    removeRetainedBlob: vi.fn(),
    scheduleSave: vi.fn(),
    notifySettingsChanged: vi.fn()
  }
}

const profile = {
  id: 'work',
  name: ' Work ',
  agent: 'codex',
  hostId: 'local',
  executable: '/opt/bin/codex',
  binding: { kind: 'external', home: '/profiles/work' }
}

describe('updateSettings agentLaunchProfiles', () => {
  it('normalizes writes and listener values while retaining ordinary settings', () => {
    const operations = makeOperations()
    const profiles = normalizeAgentLaunchProfiles([profile])
    profiles[0].name = ' Work '
    profiles.push({ ...profiles[0], id: 'bad', executable: 'relative' })
    const result = updateSettings(
      operations,
      { agentLaunchProfiles: profiles, theme: 'dark' },
      { notifyListeners: true, originWebContentsId: 7 }
    )
    expect(result.agentLaunchProfiles).toEqual([{ ...profile, name: 'Work' }])
    expect(result.theme).toBe('dark')
    expect(operations.notifySettingsChanged).toHaveBeenCalledWith(
      { agentLaunchProfiles: [{ ...profile, name: 'Work' }], theme: 'dark' },
      7
    )
    expect(operations.scheduleSave).toHaveBeenCalledOnce()
  })

  it('isolates persisted bindings from later caller mutations', () => {
    const operations = makeOperations()
    const profiles = normalizeAgentLaunchProfiles([profile])
    updateSettings(operations, { agentLaunchProfiles: profiles })
    profiles[0].name = 'Changed'
    if (profiles[0].binding.kind === 'external') {
      profiles[0].binding.home = '/changed'
    }
    profiles.splice(0)
    expect(operations.state.settings.agentLaunchProfiles).toEqual([{ ...profile, name: 'Work' }])
    updateSettings(operations, { theme: 'dark' })
    expect(operations.state.settings.agentLaunchProfiles).toEqual([{ ...profile, name: 'Work' }])
  })

  it('clears explicitly undefined profiles without converting prototype bindings', () => {
    const operations = makeOperations()
    const prototype = [{ id: 'prototype', name: 'Prototype', accountId: 'account-a' }]
    const oldSettings = {
      claudeLaunchProfiles: prototype,
      agentLaunchProfiles: normalizeAgentLaunchProfiles([profile])
    }
    updateSettings(operations, oldSettings)
    updateSettings(operations, { agentLaunchProfiles: undefined })
    expect(operations.state.settings.agentLaunchProfiles).toEqual([])
    expect(operations.state.settings).not.toHaveProperty('claudeLaunchProfiles')
  })
})
