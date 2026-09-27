import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultLocalOrcaProfile,
  DEFAULT_LOCAL_ORCA_PROFILE_ID
} from '../../shared/orca-profiles'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile
} from '../../main/orca-profiles/profile-storage-paths'
import { openProfileStateDatabase } from '../../main/persistence/profile-state/profile-state-database'
import * as profileStateDatabase from '../../main/persistence/profile-state/profile-state-database'
import {
  exportProfileStateJson,
  hashProfileStateJson,
  importProfileStateJson
} from '../../main/persistence/profile-state/profile-state-documents'
import { ProfileStateSqliteAuthority } from '../../main/persistence/profile-state/profile-state-sqlite-authority'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission,
  type ProfileStateRuntimeAdmission
} from '../../main/persistence/profile-state/profile-state-access'

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }))

const {
  applyAgentStatusHooksEnabledMock,
  callMock,
  getCliStatusMock,
  getDefaultUserDataPathMock,
  getManagedAgentHookStatusesMock,
  prepareManagedCodexHomeBeforeShellLaunchMock
} = vi.hoisted(() => ({
  applyAgentStatusHooksEnabledMock: vi.fn(),
  callMock: vi.fn(),
  getCliStatusMock: vi.fn(() =>
    Promise.resolve({
      id: 'test-status',
      ok: true,
      result: {
        app: { running: false, pid: null },
        runtime: { state: 'not_running', reachable: false, runtimeId: null },
        graph: { state: 'not_running' }
      },
      _meta: { runtimeId: 'test' }
    })
  ),
  getDefaultUserDataPathMock: vi.fn(),
  getManagedAgentHookStatusesMock: vi.fn(),
  prepareManagedCodexHomeBeforeShellLaunchMock: vi.fn()
}))

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = getCliStatusMock
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    getDefaultUserDataPath: getDefaultUserDataPathMock
  }
})

vi.mock('../../main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock,
  getManagedAgentHookStatuses: getManagedAgentHookStatusesMock
}))

vi.mock('../../main/codex/managed-home-shell-preflight', () => ({
  prepareManagedCodexHomeBeforeShellLaunch: prepareManagedCodexHomeBeforeShellLaunchMock
}))

import { main } from '../index'

function readDefaultProfileState(userDataPath: string) {
  const opened = openProfileStateDatabase(
    getOrcaProfileStateDatabaseFile(DEFAULT_LOCAL_ORCA_PROFILE_ID, userDataPath),
    DEFAULT_LOCAL_ORCA_PROFILE_ID
  )
  try {
    return JSON.parse(exportProfileStateJson(opened.db))
  } finally {
    opened.db.close()
  }
}

function writeDataFile(userDataPath: string, state: PersistedState): void {
  mkdirSync(userDataPath, { recursive: true })
  writeFileSync(join(userDataPath, 'orca-data.json'), JSON.stringify(state, null, 2), 'utf-8')
}

function writeActiveProfileIndex(userDataPath: string, profileId: string): void {
  writeFileSync(
    join(userDataPath, 'orca-profile-index.json'),
    JSON.stringify({
      activeProfileId: profileId,
      profiles: [{ ...createDefaultLocalOrcaProfile(1), id: profileId }]
    }),
    'utf-8'
  )
}

async function runAgentHooksOff(userDataPath: string): Promise<void> {
  getDefaultUserDataPathMock.mockReturnValue(userDataPath)
  await main(['agent', 'hooks', 'off', '--json'], userDataPath)
}

describe('agent hooks CLI handler', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-agent-hooks-cli-'))
    applyAgentStatusHooksEnabledMock.mockReset().mockReturnValue([])
    callMock.mockReset()
    getCliStatusMock.mockClear()
    getManagedAgentHookStatusesMock.mockReturnValue([])
    prepareManagedCodexHomeBeforeShellLaunchMock.mockReset()
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('keeps new card style off when creating offline settings for a fresh profile', async () => {
    await runAgentHooksOff(userDataPath)

    const persisted = readDefaultProfileState(userDataPath)

    expect(persisted.settings.experimentalNewWorktreeCardStyle).toBe(false)
    expect(persisted.settings.agentStatusHooksEnabled).toBe(false)
    expect(existsSync(join(userDataPath, 'orca-data.json'))).toBe(false)
    expect(existsSync(getOrcaProfileDataFile(DEFAULT_LOCAL_ORCA_PROFILE_ID, userDataPath))).toBe(
      false
    )
  })

  it.each(['fresh', 'root-json', 'profile-json'] as const)(
    'refuses an incapable offline writer before any %s profile or hook changes',
    async (source) => {
      const profileId = 'unsupported-runtime'
      const state = getDefaultPersistedState(userDataPath)
      const directory =
        source === 'profile-json' ? join(userDataPath, 'profiles', profileId) : userDataPath
      if (source !== 'fresh') {
        writeDataFile(directory, state)
      }
      if (source === 'profile-json') {
        writeActiveProfileIndex(userDataPath, profileId)
      }
      vi.spyOn(profileStateDatabase, 'isProfileStateSqliteAvailable').mockReturnValue(false)

      await runAgentHooksOff(userDataPath)

      expect(process.exitCode).toBe(1)
      expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
      expect(existsSync(join(userDataPath, '.profile-state-access'))).toBe(false)
      expect(existsSync(getOrcaProfileStateDatabaseFile(profileId, userDataPath))).toBe(false)
      expect(
        existsSync(getOrcaProfileStateDatabaseFile(DEFAULT_LOCAL_ORCA_PROFILE_ID, userDataPath))
      ).toBe(false)
      if (source !== 'fresh') {
        expect(JSON.parse(readFileSync(join(directory, 'orca-data.json'), 'utf8'))).toEqual(state)
      }
      if (source !== 'profile-json') {
        expect(existsSync(join(userDataPath, 'orca-profile-index.json'))).toBe(false)
      }
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('bundled Orca CLI'))
    }
  )

  it('keeps runtime writes available to an incapable CLI', async () => {
    vi.spyOn(profileStateDatabase, 'isProfileStateSqliteAvailable').mockReturnValue(false)
    getCliStatusMock.mockResolvedValueOnce({
      id: 'test-status',
      ok: true,
      result: {
        app: { running: true, pid: null },
        runtime: { state: 'ready', reachable: true, runtimeId: null },
        graph: { state: 'ready' }
      },
      _meta: { runtimeId: 'test' }
    })
    callMock.mockResolvedValueOnce({ result: {} })

    await runAgentHooksOff(userDataPath)

    expect(process.exitCode).not.toBe(1)
    expect(callMock).toHaveBeenCalledWith(
      'settings.update',
      { agentStatusHooksEnabled: false },
      { timeoutMs: 10_000 }
    )
    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
    expect(existsSync(join(userDataPath, '.profile-state-access'))).toBe(false)
    expect(existsSync(join(userDataPath, 'orca-profile-index.json'))).toBe(false)
  })

  it.each(['root', 'indexed'] as const)(
    'reads %s JSON status without SQLite or migration',
    async (source) => {
      const profileId = 'read-only'
      const directory =
        source === 'indexed' ? join(userDataPath, 'profiles', profileId) : userDataPath
      writeDataFile(directory, getDefaultPersistedState(userDataPath))
      if (source === 'indexed') {
        writeActiveProfileIndex(userDataPath, profileId)
      }
      getDefaultUserDataPathMock.mockReturnValue(userDataPath)
      vi.spyOn(profileStateDatabase, 'isProfileStateSqliteAvailable').mockReturnValue(false)
      const original = readFileSync(join(directory, 'orca-data.json'), 'utf8')

      await main(['agent', 'hooks', 'status', '--json'], userDataPath)

      expect(process.exitCode).not.toBe(1)
      expect(readFileSync(join(directory, 'orca-data.json'), 'utf8')).toBe(original)
      expect(existsSync(join(directory, 'profile-state.db'))).toBe(false)
      expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
    }
  )

  it.each(['missing', 'corrupt'] as const)(
    'uses the backup index when the primary is %s',
    async (primary) => {
      const profileId = 'backup-selected'
      const indexPath = join(userDataPath, 'orca-profile-index.json')
      writeActiveProfileIndex(userDataPath, profileId)
      fs.renameSync(indexPath, `${indexPath}.bak`)
      if (primary === 'corrupt') {
        writeFileSync(indexPath, '{broken')
      }
      writeDataFile(
        join(userDataPath, 'profiles', profileId),
        getDefaultPersistedState(userDataPath)
      )

      await runAgentHooksOff(userDataPath)

      expect(process.exitCode).not.toBe(1)
      expect(existsSync(getOrcaProfileStateDatabaseFile(profileId, userDataPath))).toBe(true)
      expect(
        existsSync(getOrcaProfileStateDatabaseFile(DEFAULT_LOCAL_ORCA_PROFILE_ID, userDataPath))
      ).toBe(false)
      const { ensureActiveOrcaProfile } =
        await import('../../main/orca-profiles/profile-index-store.js')
      expect(ensureActiveOrcaProfile(userDataPath).profile.id).toBe(profileId)
    }
  )

  it.each([0, 1, 2, 3, 4])('refuses a pre-index root with only legacy backup %s', async (slot) => {
    const backup = join(userDataPath, `orca-data.json.bak.${slot}`)
    const source = '{"settings":{"agentStatusHooksEnabled":true}}'
    writeFileSync(backup, source)

    await runAgentHooksOff(userDataPath)

    expect(process.exitCode).toBe(1)
    expect(readFileSync(backup, 'utf8')).toBe(source)
    expect(existsSync(join(userDataPath, 'orca-profile-index.json'))).toBe(false)
    expect(existsSync(join(userDataPath, 'profiles'))).toBe(false)
    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
  })

  it.each(['root-json', 'profile-json', 'sqlite'] as const)(
    'refuses offline %s mutation when startup wins after the stopped-status response',
    async (backend) => {
      const profileId = 'startup-race'
      const directory =
        backend === 'root-json' ? userDataPath : join(userDataPath, 'profiles', profileId)
      mkdirSync(directory, { recursive: true })
      const dataFile = join(directory, 'orca-data.json')
      const raw = JSON.stringify({
        settings: { agentStatusHooksEnabled: true },
        unknown: { retained: null }
      })
      writeFileSync(dataFile, raw)
      if (backend !== 'root-json') {
        writeActiveProfileIndex(userDataPath, profileId)
      }
      const databaseFile = join(directory, 'profile-state.db')
      if (backend === 'sqlite') {
        const opened = openProfileStateDatabase(databaseFile, profileId)
        try {
          importProfileStateJson(opened.db, raw, {
            acceptedLegacyJsonHash: hashProfileStateJson(raw)
          })
        } finally {
          opened.db.close()
        }
      }
      const stopped = await getCliStatusMock()
      let runtime: ProfileStateRuntimeAdmission | undefined
      getCliStatusMock.mockImplementationOnce(async () => {
        runtime = acquireProfileStateRuntimeAdmission(userDataPath)
        return stopped
      })
      try {
        await runAgentHooksOff(userDataPath)
        expect(process.exitCode).toBe(1)
        expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
        expect(readFileSync(dataFile, 'utf8')).toBe(raw)
        if (backend === 'sqlite') {
          const opened = openProfileStateDatabase(databaseFile, profileId)
          try {
            expect(JSON.parse(exportProfileStateJson(opened.db))).toEqual(JSON.parse(raw))
          } finally {
            opened.db.close()
          }
        }
      } finally {
        runtime?.release()
      }
      process.exitCode = undefined
      await runAgentHooksOff(userDataPath)
      expect(process.exitCode).not.toBe(1)
      expect(applyAgentStatusHooksEnabledMock).toHaveBeenCalledOnce()
    }
  )

  it.each(['root-json', 'profile-json'] as const)(
    'excludes startup and other offline writers through %s publication',
    async (backend) => {
      const profileId = 'offline-first'
      const directory =
        backend === 'root-json' ? userDataPath : join(userDataPath, 'profiles', profileId)
      mkdirSync(directory, { recursive: true })
      if (backend === 'profile-json') {
        writeActiveProfileIndex(userDataPath, profileId)
      }
      const dataFile = join(directory, 'orca-data.json')
      writeFileSync(dataFile, JSON.stringify({ settings: { agentStatusHooksEnabled: true } }))
      const databaseFile = getOrcaProfileStateDatabaseFile(
        backend === 'root-json' ? DEFAULT_LOCAL_ORCA_PROFILE_ID : profileId,
        userDataPath
      )
      const link = fs.linkSync
      let checkedPublication = false
      vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
        if (target === databaseFile) {
          checkedPublication = true
          expect(() => acquireProfileStateRuntimeAdmission(userDataPath)).toThrow()
          expect(() => acquireProfileStateMaintenance(userDataPath)).toThrow()
        }
        return link(source, target)
      })
      await runAgentHooksOff(userDataPath)
      expect(checkedPublication).toBe(true)
      expect(process.exitCode).not.toBe(1)
      const runtime = acquireProfileStateRuntimeAdmission(userDataPath)
      try {
        const opened = openProfileStateDatabase(
          databaseFile,
          backend === 'root-json' ? DEFAULT_LOCAL_ORCA_PROFILE_ID : profileId
        )
        try {
          expect(
            JSON.parse(exportProfileStateJson(opened.db)).settings.agentStatusHooksEnabled
          ).toBe(false)
        } finally {
          opened.db.close()
        }
        expect(JSON.parse(readFileSync(dataFile, 'utf8')).settings.agentStatusHooksEnabled).toBe(
          true
        )
      } finally {
        runtime.release()
      }
    }
  )

  it('keeps missing new card style off when updating offline settings', async () => {
    const existing = getDefaultPersistedState(userDataPath)
    delete existing.settings.experimentalNewWorktreeCardStyle
    writeDataFile(userDataPath, existing)

    await runAgentHooksOff(userDataPath)

    expect(readDefaultProfileState(userDataPath).settings.experimentalNewWorktreeCardStyle).toBe(
      false
    )
  })

  it('preserves an existing explicit new card style opt-in when updating offline settings', async () => {
    const existing = getDefaultPersistedState(userDataPath)
    existing.settings.experimentalNewWorktreeCardStyle = true
    writeDataFile(userDataPath, existing)

    await runAgentHooksOff(userDataPath)

    expect(readDefaultProfileState(userDataPath).settings.experimentalNewWorktreeCardStyle).toBe(
      true
    )
  })

  it.each(['on', 'off', 'status', 'prepare-codex'])(
    'refuses explicit remote selection before local hook command %s',
    async (command) => {
      const state = getDefaultPersistedState(userDataPath)
      writeDataFile(userDataPath, state)
      const before = readFileSync(join(userDataPath, 'orca-data.json'), 'utf8')
      getDefaultUserDataPathMock.mockReturnValue(userDataPath)

      for (const selector of ['environment', 'pairing-code']) {
        process.exitCode = undefined
        await main(
          ['agent', 'hooks', command, `--${selector}`, 'unreachable-host', '--json'],
          userDataPath
        )

        expect(process.exitCode).toBe(1)
        expect(getCliStatusMock).not.toHaveBeenCalled()
        expect(callMock).not.toHaveBeenCalled()
        expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
        expect(prepareManagedCodexHomeBeforeShellLaunchMock).not.toHaveBeenCalled()
        expect(readFileSync(join(userDataPath, 'orca-data.json'), 'utf8')).toBe(before)
      }
    }
  )

  it('prepares managed Codex trust with the current hooks setting', async () => {
    const state = getDefaultPersistedState(userDataPath)
    state.settings.agentStatusHooksEnabled = false
    writeDataFile(userDataPath, state)
    getDefaultUserDataPathMock.mockReturnValue(userDataPath)

    await main(['agent', 'hooks', 'prepare-codex'], userDataPath)

    expect(prepareManagedCodexHomeBeforeShellLaunchMock).toHaveBeenCalledWith({
      userDataPath,
      hooksEnabled: false
    })
  })

  it('forwards WSL pane routing to the runtime exactly once without using the host installer', async () => {
    const home = '/home/jin/.local/share/orca/codex-runtime-home/home'
    vi.stubEnv('CODEX_HOME', home)
    vi.stubEnv('ORCA_CODEX_HOME', home)
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu-24.04')
    callMock.mockResolvedValue({ result: { state: 'installed' } })

    await main(['agent', 'hooks', 'prepare-codex'], userDataPath)

    expect(callMock).toHaveBeenCalledExactlyOnceWith(
      'agentHooks.prepareCodexForWslPane',
      { codexHome: home, orcaCodexHome: home, wslDistro: 'Ubuntu-24.04' },
      { timeoutMs: 50_000 }
    )
    expect(prepareManagedCodexHomeBeforeShellLaunchMock).not.toHaveBeenCalled()
  })

  it('fails open when WSL runtime preparation is unavailable', async () => {
    vi.stubEnv('CODEX_HOME', '/home/jin/.local/share/orca/codex-runtime-home/home')
    vi.stubEnv('ORCA_CODEX_HOME', '/home/jin/.local/share/orca/codex-runtime-home/home')
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
    callMock.mockRejectedValue(new Error('method_not_found'))

    await expect(main(['agent', 'hooks', 'prepare-codex'], userDataPath)).resolves.toBeUndefined()
    expect(prepareManagedCodexHomeBeforeShellLaunchMock).not.toHaveBeenCalled()
  })

  it('honors Codex-specific disablement when the runtime is unavailable', async () => {
    const state = getDefaultPersistedState(userDataPath)
    state.settings.disabledTuiAgents = ['codex']
    writeDataFile(userDataPath, state)
    getDefaultUserDataPathMock.mockReturnValue(userDataPath)

    await main(['agent', 'hooks', 'prepare-codex'], userDataPath)

    expect(prepareManagedCodexHomeBeforeShellLaunchMock).toHaveBeenCalledWith({
      userDataPath,
      hooksEnabled: false
    })
  })

  it('uses the active profile settings instead of stale legacy settings', async () => {
    const profileId = 'work-profile'
    const legacy = getDefaultPersistedState(userDataPath)
    legacy.settings.agentStatusHooksEnabled = true
    writeDataFile(userDataPath, legacy)
    const profile = getDefaultPersistedState(userDataPath)
    profile.settings.agentStatusHooksEnabled = false
    writeDataFile(join(userDataPath, 'profiles', profileId), profile)
    writeFileSync(
      join(userDataPath, 'orca-profile-index.json'),
      JSON.stringify({
        activeProfileId: profileId,
        profiles: [{ id: profileId }]
      }),
      'utf-8'
    )
    getDefaultUserDataPathMock.mockReturnValue(userDataPath)

    await main(['agent', 'hooks', 'prepare-codex'], userDataPath)

    expect(prepareManagedCodexHomeBeforeShellLaunchMock).toHaveBeenCalledWith({
      userDataPath,
      hooksEnabled: false
    })
  })

  it('honors live hook and Codex-specific disablement before persistence settles', async () => {
    const state = getDefaultPersistedState(userDataPath)
    state.settings.agentStatusHooksEnabled = true
    writeDataFile(userDataPath, state)
    getDefaultUserDataPathMock.mockReturnValue(userDataPath)
    callMock.mockResolvedValue({
      result: {
        settings: { agentStatusHooksEnabled: true, disabledTuiAgents: ['codex'] }
      }
    })

    await main(['agent', 'hooks', 'prepare-codex'], userDataPath)

    expect(prepareManagedCodexHomeBeforeShellLaunchMock).toHaveBeenCalledWith({
      userDataPath,
      hooksEnabled: false
    })
    expect(callMock).toHaveBeenCalledExactlyOnceWith('settings.get', undefined, {
      timeoutMs: 1_000
    })
  })

  it('updates an established SQLite profile without rewriting its JSON export', async () => {
    const profileId = 'work-profile'
    const profileDirectory = join(userDataPath, 'profiles', profileId)
    const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
    const databaseFile = getOrcaProfileStateDatabaseFile(profileId, userDataPath)
    const raw = JSON.stringify({
      settings: {
        agentStatusHooksEnabled: true,
        disabledTuiAgents: ['codex'],
        opencodeSessionCookie: 'encrypted-ciphertext'
      },
      unknownDomain: { preserved: true }
    })
    mkdirSync(profileDirectory, { recursive: true })
    writeFileSync(dataFile, raw, 'utf-8')
    writeActiveProfileIndex(userDataPath, profileId)
    const opened = openProfileStateDatabase(databaseFile, profileId)
    try {
      importProfileStateJson(opened.db, raw, {
        acceptedLegacyJsonHash: hashProfileStateJson(raw)
      })
    } finally {
      opened.db.close()
    }

    await runAgentHooksOff(userDataPath)

    expect(readFileSync(dataFile, 'utf-8')).toBe(raw)
    const readBack = openProfileStateDatabase(databaseFile, profileId)
    try {
      expect(JSON.parse(exportProfileStateJson(readBack.db))).toMatchObject({
        settings: {
          agentStatusHooksEnabled: false,
          opencodeSessionCookie: 'encrypted-ciphertext',
          disabledTuiAgents: ['codex']
        },
        unknownDomain: { preserved: true }
      })
    } finally {
      readBack.db.close()
    }
  })

  it.each(['update-failed', 'unreachable', 'status-failed'] as const)(
    'preserves a live SQLite writer when runtime contact is %s',
    async (failure) => {
      const profileId = 'live-profile'
      const profileDirectory = join(userDataPath, 'profiles', profileId)
      mkdirSync(profileDirectory, { recursive: true })
      writeActiveProfileIndex(userDataPath, profileId)
      const authority = new ProfileStateSqliteAuthority(
        getOrcaProfileStateDatabaseFile(profileId, userDataPath),
        profileId
      )
      authority.writeSerializedState(
        Buffer.from(JSON.stringify({ settings: { agentStatusHooksEnabled: true } }))
      )
      if (failure === 'status-failed') {
        getCliStatusMock.mockRejectedValueOnce(new Error('status transport unavailable'))
      } else {
        getCliStatusMock.mockResolvedValueOnce({
          id: 'test-status',
          ok: true,
          result: {
            app: { running: true, pid: null },
            runtime: {
              state: failure === 'unreachable' ? 'starting' : 'ready',
              reachable: failure !== 'unreachable',
              runtimeId: null
            },
            graph: { state: 'ready' }
          },
          _meta: { runtimeId: 'test' }
        })
        callMock.mockRejectedValueOnce(new Error('settings request timed out'))
      }
      try {
        await runAgentHooksOff(userDataPath)

        expect(process.exitCode).toBe(1)
        expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
        expect(() =>
          authority.writeSerializedDomains([
            { domain: 'ui', payload: '{"marker":"still-writable"}' }
          ])
        ).not.toThrow()
        const persisted = JSON.parse(authority.readSerializedState() ?? '{}')
        expect(persisted).toMatchObject({
          settings: { agentStatusHooksEnabled: true },
          ui: { marker: 'still-writable' }
        })
      } finally {
        authority.close()
      }
    }
  )

  it('imports a JSON-only active profile before the first settings mutation', async () => {
    const profileId = 'json-profile'
    const profileDirectory = join(userDataPath, 'profiles', profileId)
    mkdirSync(profileDirectory, { recursive: true })
    writeDataFile(profileDirectory, getDefaultPersistedState(userDataPath))
    writeActiveProfileIndex(userDataPath, profileId)

    await runAgentHooksOff(userDataPath)

    expect(existsSync(getOrcaProfileStateDatabaseFile(profileId, userDataPath))).toBe(true)
    expect(
      JSON.parse(readFileSync(getOrcaProfileDataFile(profileId, userDataPath), 'utf-8')).settings
        .agentStatusHooksEnabled
    ).toBe(true)
    const opened = openProfileStateDatabase(
      getOrcaProfileStateDatabaseFile(profileId, userDataPath),
      profileId
    )
    try {
      expect(JSON.parse(exportProfileStateJson(opened.db)).settings.agentStatusHooksEnabled).toBe(
        false
      )
    } finally {
      opened.db.close()
    }
  })

  it('fails closed when a profile has corrupt SQLite alongside legacy JSON', async () => {
    const profileId = 'corrupt-profile'
    const profileDirectory = join(userDataPath, 'profiles', profileId)
    mkdirSync(profileDirectory, { recursive: true })
    const state = getDefaultPersistedState(userDataPath)
    writeDataFile(profileDirectory, state)
    writeActiveProfileIndex(userDataPath, profileId)
    const databaseFile = getOrcaProfileStateDatabaseFile(profileId, userDataPath)
    writeFileSync(databaseFile, 'not sqlite', 'utf-8')
    const before = readFileSync(getOrcaProfileDataFile(profileId, userDataPath), 'utf-8')

    await runAgentHooksOff(userDataPath)

    expect(process.exitCode).toBe(1)
    expect(readFileSync(getOrcaProfileDataFile(profileId, userDataPath), 'utf-8')).toBe(before)
  })

  it('fails closed when a profile index is present but unreadable', async () => {
    const legacy = getDefaultPersistedState(userDataPath)
    writeDataFile(userDataPath, legacy)
    writeFileSync(join(userDataPath, 'orca-profile-index.json'), '{ torn', 'utf-8')
    const before = readFileSync(join(userDataPath, 'orca-data.json'), 'utf-8')

    await runAgentHooksOff(userDataPath)

    expect(process.exitCode).toBe(1)
    expect(readFileSync(join(userDataPath, 'orca-data.json'), 'utf-8')).toBe(before)
  })
})
