import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openProfileStateDatabase } from './profile-state-database'
import { importProfileStateJson, readProfileStateSnapshot } from './profile-state-documents'
import { updateAgentHookSettingsFromProfileState } from './profile-state-offline-settings'

it('changes agent hooks offline without granting publishing permission to an older profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-offline-sharing-'))
  const location = {
    profileId: 'older-profile',
    dataFile: join(root, 'orca-data.json'),
    databaseFile: join(root, 'profile-state.db')
  }
  try {
    const opened = openProfileStateDatabase(location.databaseFile, location.profileId)
    try {
      importProfileStateJson(opened.db, '{"settings":{"agentStatusHooksEnabled":true}}')
    } finally {
      opened.db.close()
    }

    updateAgentHookSettingsFromProfileState(location, false)
    updateAgentHookSettingsFromProfileState(location, true)

    const reopened = openProfileStateDatabase(location.databaseFile, location.profileId)
    try {
      const { settings } = JSON.parse(readProfileStateSnapshot(reopened.db).json)
      expect(settings.agentStatusHooksEnabled).toBe(true)
      expect(settings).not.toHaveProperty('artifactSharingEnabled')
    } finally {
      reopened.db.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
