import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readAgentHookSettingsFromProfileState,
  updateAgentHookSettingsFromProfileState
} from './profile-state-offline-settings'
import * as exportPaths from './legacy-json/profile-state-export-path'
import { ProfileStateRecoveryRequiredError } from './profile-state-recovery-required'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { Store } from '../loading-store/store'
import {
  hasProfileStateAuthorityMarker,
  profileStateAuthorityMarkerPath
} from './profile-state-authority-marker'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createLocation() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-offline-settings-'))
  directories.push(directory)
  return {
    dataFile: join(directory, 'orca-data.json'),
    databaseFile: join(directory, 'orca-state.db'),
    profileId: 'profile-offline'
  }
}

describe.each(['json', 'sqlite'] as const)('offline settings %s updates', (backend) => {
  it.each([undefined, false, 'true', true])(
    'preserves raw Portuguese marker %j before normal load',
    async (marker) => {
      const location = createLocation()
      const plugin = 'plugin:stablyai.orca-portuguese/pt-BR'
      const original = {
        settings: {
          uiLanguage: plugin,
          uiLanguagePortugueseMigrationApplied: marker,
          futureSetting: { retained: true }
        },
        pluginData: { untouched: true }
      }
      const authority = new ProfileStateSqliteAuthority(location.databaseFile, location.profileId)
      if (backend === 'sqlite') {
        authority.writeSerializedState(Buffer.from(JSON.stringify(original)))
        authority.close()
      } else {
        writeFileSync(location.dataFile, JSON.stringify(original))
      }
      updateAgentHookSettingsFromProfileState(location, false)
      const beforeLoad = JSON.parse(authority.readSerializedState() ?? 'null')
      expect(beforeLoad.settings.uiLanguage).toBe(plugin)
      expect(beforeLoad.settings.uiLanguagePortugueseMigrationApplied).toBe(marker)
      expect(Object.hasOwn(beforeLoad.settings, 'uiLanguagePortugueseMigrationApplied')).toBe(
        marker !== undefined
      )
      expect(beforeLoad.pluginData).toEqual(original.pluginData)
      authority.close()
      vi.useFakeTimers()
      const loaded = new Store({
        dataFile: location.dataFile,
        profileStateAuthority: new ProfileStateSqliteAuthority(
          location.databaseFile,
          location.profileId
        )
      })
      try {
        vi.advanceTimersByTime(5000)
        await loaded.waitForPendingWrite()
        const persisted = JSON.parse(authority.readSerializedState() ?? 'null')
        expect(persisted.settings).toMatchObject({
          uiLanguage: marker === true ? plugin : 'pt',
          uiLanguagePortugueseMigrationApplied: true
        })
      } finally {
        await loaded.freezeWritesAsync()
        authority.close()
        vi.useRealTimers()
      }
      const reopened = new Store({
        dataFile: location.dataFile,
        profileStateAuthority: new ProfileStateSqliteAuthority(
          location.databaseFile,
          location.profileId
        )
      })
      try {
        expect(reopened.getSettings()).toMatchObject({
          uiLanguage: marker === true ? plugin : 'pt',
          uiLanguagePortugueseMigrationApplied: true
        })
      } finally {
        await reopened.freezeWritesAsync()
      }
    }
  )

  it.each([false, true])(
    'keeps migration-sensitive absence through edit/import then flush/reopen (initialized=%s)',
    async (initialized) => {
      const location = createLocation()
      const original = {
        settings: {
          agentPermissionDefault: 'own',
          agentPermissionOverrides: {},
          agentDefaultArgs: { claude: '--model opus --effort high --verbose' },
          ...(initialized ? { agentLaunchChoices: {} } : {})
        }
      }
      const authority = new ProfileStateSqliteAuthority(location.databaseFile, location.profileId)
      if (backend === 'json') {
        writeFileSync(location.dataFile, JSON.stringify(original))
      } else {
        authority.writeSerializedState(Buffer.from(JSON.stringify(original)))
        authority.close()
      }
      updateAgentHookSettingsFromProfileState(location, false)
      const before = JSON.parse(authority.readSerializedState() ?? 'null')
      expect(Object.hasOwn(before.settings, 'agentLaunchChoices')).toBe(initialized)
      authority.close()
      vi.useFakeTimers()
      const loaded = new Store({
        dataFile: location.dataFile,
        profileStateAuthority: new ProfileStateSqliteAuthority(
          location.databaseFile,
          location.profileId
        )
      })
      try {
        expect(loaded.getSettings().agentLaunchChoices).toEqual(
          initialized ? {} : { claude: { model: 'opus', options: { effort: 'high' } } }
        )
        vi.advanceTimersByTime(5000)
        await loaded.waitForPendingWrite()
      } finally {
        await loaded.freezeWritesAsync()
        vi.useRealTimers()
      }
      const reopened = new Store({
        dataFile: location.dataFile,
        profileStateAuthority: new ProfileStateSqliteAuthority(
          location.databaseFile,
          location.profileId
        )
      })
      try {
        expect(reopened.getSettings().agentLaunchChoices).toEqual(
          initialized ? {} : { claude: { model: 'opus', options: { effort: 'high' } } }
        )
        expect(reopened.getSettings().agentStatusHooksEnabled).toBe(false)
        expect(reopened.getSettings().agentDefaultArgs?.claude).toContain('--verbose')
      } finally {
        await reopened.freezeWritesAsync()
      }
    }
  )

  it.each([undefined, null, 42])(
    'does not stamp missing/non-object existing settings %j',
    (settings) => {
      const location = createLocation()
      const original = JSON.stringify({ settings })
      const authority = new ProfileStateSqliteAuthority(location.databaseFile, location.profileId)
      try {
        if (backend === 'sqlite') {
          authority.writeSerializedState(Buffer.from(original))
          authority.close()
        } else {
          writeFileSync(location.dataFile, original)
        }
        updateAgentHookSettingsFromProfileState(location, true)
        expect(JSON.parse(authority.readSerializedState() ?? 'null').settings).not.toHaveProperty(
          'uiLanguagePortugueseMigrationApplied'
        )
      } finally {
        authority.close()
      }
    }
  )

  it('filters malformed hook settings for callers while preserving their stored values', () => {
    const location = createLocation()
    const original = {
      settings: {
        agentStatusHooksEnabled: true,
        agentCmdOverrides: { codex: 42, claude: 'claude --model opus', gemini: null },
        disabledTuiAgents: ['codex', false, 'future-agent', 'codex'],
        futureSetting: { preserved: true }
      },
      futureDomain: { preserved: ['雪', null] }
    }
    const authority = new ProfileStateSqliteAuthority(location.databaseFile, location.profileId)
    try {
      if (backend === 'sqlite') {
        authority.writeSerializedState(Buffer.from(JSON.stringify(original)))
        authority.close()
        rmSync(profileStateAuthorityMarkerPath(location.databaseFile), { force: true })
      } else {
        writeFileSync(location.dataFile, JSON.stringify(original))
      }

      expect(updateAgentHookSettingsFromProfileState(location, false)).toEqual({
        settingsPath: location.databaseFile,
        settings: {
          agentCmdOverrides: { claude: 'claude --model opus' },
          disabledTuiAgents: ['codex', 'future-agent', 'codex']
        }
      })
      const persisted = authority.readSerializedState()
      expect(hasProfileStateAuthorityMarker(location.databaseFile)).toBe(true)
      if (backend === 'json') {
        expect(readFileSync(location.dataFile, 'utf8')).toBe(JSON.stringify(original))
      }
      expect(JSON.parse(persisted ?? 'null')).toMatchObject({
        ...original,
        settings: { ...original.settings, agentStatusHooksEnabled: false }
      })
    } finally {
      authority.close()
    }
  })
})

it('keeps offline no-storage initialization stamped', () => {
  const location = createLocation()
  updateAgentHookSettingsFromProfileState(location, true)
  const authority = new ProfileStateSqliteAuthority(location.databaseFile, location.profileId)
  try {
    expect(JSON.parse(authority.readSerializedState() ?? 'null').settings).toMatchObject({
      agentStatusHooksEnabled: true,
      uiLanguagePortugueseMigrationApplied: true
    })
  } finally {
    authority.close()
  }
})

describe.each(['read', 'update'] as const)('offline settings %s recovery', (operation) => {
  function run(location: ReturnType<typeof createLocation>) {
    return operation === 'read'
      ? readAgentHookSettingsFromProfileState(location)
      : updateAgentHookSettingsFromProfileState(location, false)
  }

  it.each([true, false])('rejects marker-only evidence with JSON present=%s', (hasJson) => {
    const location = createLocation()
    const source = JSON.stringify({ settings: { agentStatusHooksEnabled: true } })
    if (hasJson) {
      writeFileSync(location.dataFile, source)
    }
    writeFileSync(profileStateAuthorityMarkerPath(location.databaseFile), 'sqlite\n')
    expect(() => run(location)).toThrow(ProfileStateRecoveryRequiredError)
    expect(existsSync(location.databaseFile)).toBe(false)
    expect(existsSync(location.dataFile)).toBe(hasJson)
    if (hasJson) {
      expect(readFileSync(location.dataFile, 'utf8')).toBe(source)
    }
  })

  it.each([true, false])('rejects retained exports with JSON present=%s', (hasJson) => {
    const location = createLocation()
    const source = JSON.stringify({ settings: { agentStatusHooksEnabled: true } })
    if (hasJson) {
      writeFileSync(location.dataFile, source)
    }
    const exportFile = exportPaths.profileStateJsonExportPath(location.dataFile, 1)
    writeFileSync(exportFile, source)
    // Recovery detection must also work in the Node 18 fallback without SQLite.
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)

    expect(() => run(location)).toThrowError(ProfileStateRecoveryRequiredError)
    expect(existsSync(location.databaseFile)).toBe(false)
    expect(existsSync(location.dataFile)).toBe(hasJson)
    expect(readFileSync(exportFile, 'utf8')).toBe(source)
    if (hasJson) {
      expect(readFileSync(location.dataFile, 'utf8')).toBe(source)
    }
  })

  it.each([0, 1, 2, 3, 4])('refuses defaults when only legacy backup %s remains', (slot) => {
    const location = createLocation()
    const backup = `${location.dataFile}.bak.${slot}`
    const source = '{"settings":{"agentStatusHooksEnabled":false}}'
    writeFileSync(backup, source)

    expect(() => run(location)).toThrow('restore a selected backup')
    expect(existsSync(location.dataFile)).toBe(false)
    expect(existsSync(location.databaseFile)).toBe(false)
    expect(readFileSync(backup, 'utf8')).toBe(source)
  })

  it('fails closed when retained exports cannot be enumerated', () => {
    const location = createLocation()
    vi.spyOn(exportPaths, 'profileStateJsonExportPaths').mockImplementation(() => {
      throw new Error('permission denied')
    })

    expect(() => run(location)).toThrowError(ProfileStateRecoveryRequiredError)
    expect(existsSync(location.dataFile)).toBe(false)
    expect(existsSync(location.databaseFile)).toBe(false)
  })

  it.each(['-wal', '-shm', '-journal'])('rejects stale JSON when only %s remains', (suffix) => {
    const location = createLocation()
    const source = JSON.stringify({ settings: { agentStatusHooksEnabled: true } })
    writeFileSync(location.dataFile, source)
    const sidecar = `${location.databaseFile}${suffix}`
    writeFileSync(sidecar, 'orphaned recovery evidence')

    expect(() => run(location)).toThrow()
    expect(readFileSync(location.dataFile, 'utf8')).toBe(source)
    expect(existsSync(location.databaseFile)).toBe(false)
    expect(readFileSync(sidecar, 'utf8')).toBe('orphaned recovery evidence')
  })
})
