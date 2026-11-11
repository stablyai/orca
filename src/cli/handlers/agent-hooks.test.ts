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
import { openProfileStateDatabase } from '../../main/persistence/profile-state/database/profile-state-database'
import * as profileStateDatabase from '../../main/sqlite/sync-database'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../../main/persistence/profile-state/documents/profile-state-documents'
import { hashProfileStatePayload as hashProfileStateJson } from '../../main/persistence/profile-state/documents/profile-state-document-validation'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission,
  type ProfileStateRuntimeAdmission
} from '../../main/persistence/profile-state/access/profile-state-access'

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }))

const {
  applyAgentStatusHooksEnabledMock,
  callMock,
  getCliStatusMock,
  getDefaultUserDataPathMock,
  getManagedAgentHookStatusesMock
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
  getManagedAgentHookStatusesMock: vi.fn()
}))

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    call = callMock
    async getOfflineRuntimeAdmission() {
      const status = await getCliStatusMock()
      return {
        reachable: status.result.runtime.reachable,
        legacyPidRunning: status.result.app.running,
        pid: status.result.app.pid ?? null
      }
    }
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

vi.mock('../../main/agent-hooks/installation/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock,
  getManagedAgentHookStatuses: getManagedAgentHookStatusesMock
}))

import { main } from '../index'

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
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
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
      vi.spyOn(profileStateDatabase, 'isSqliteAvailable').mockReturnValue(false)

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
      vi.spyOn(profileStateDatabase, 'isSqliteAvailable').mockReturnValue(false)
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
    }
  )

  it.each([0])('refuses a pre-index root with only legacy backup %s', async (slot) => {
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
    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
    expect(readFileSync(getOrcaProfileDataFile(profileId, userDataPath), 'utf-8')).toBe(before)
    expect(readFileSync(databaseFile, 'utf-8')).toBe('not sqlite')
  })

  it('fails closed when a profile index is present but unreadable', async () => {
    const legacy = getDefaultPersistedState(userDataPath)
    writeDataFile(userDataPath, legacy)
    writeFileSync(join(userDataPath, 'orca-profile-index.json'), '{ torn', 'utf-8')
    const before = readFileSync(join(userDataPath, 'orca-data.json'), 'utf-8')

    await runAgentHooksOff(userDataPath)

    expect(process.exitCode).toBe(1)
    expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
    expect(readFileSync(join(userDataPath, 'orca-data.json'), 'utf-8')).toBe(before)
  })
})
