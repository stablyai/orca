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

describe.each(['read', 'update'] as const)('offline settings %s recovery', (operation) => {
  function run(location: ReturnType<typeof createLocation>) {
    return operation === 'read'
      ? readAgentHookSettingsFromProfileState(location)
      : updateAgentHookSettingsFromProfileState(location, false)
  }

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
