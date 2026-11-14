import type * as RuntimeMetadata from '../runtime/profile/metadata'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultLocalOrcaProfile } from '../../shared/orca-profiles'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile
} from '../../main/orca-profiles/profile-storage-paths'
import { openProfileStateDatabase } from '../../main/persistence/profile-state/database/profile-state-database'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../../main/persistence/profile-state/documents/profile-state-documents'
import { hashProfileStatePayload as hashProfileStateJson } from '../../main/persistence/profile-state/documents/profile-state-document-validation'
import {
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

vi.mock('../runtime/client', () => {
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

  return { RuntimeClient }
})

vi.mock('../runtime/profile/metadata', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeMetadata>()),
  getDefaultUserDataPath: getDefaultUserDataPathMock
}))

vi.mock('../../main/agent-hooks/installation/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock,
  getManagedAgentHookStatuses: getManagedAgentHookStatusesMock
}))

import { main } from '../index'

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

  it.each([
    { label: 'offline', reachable: false, enabled: true, appliedBy: 'offline' },
    { label: 'connected', reachable: true, enabled: false, appliedBy: 'runtime' }
  ] as const)(
    'reports $label hook status against the SQLite file that holds the setting',
    async ({ reachable, enabled, appliedBy }) => {
      const profileId = 'sqlite-status'
      writeActiveProfileIndex(userDataPath, profileId)
      const databaseFile = getOrcaProfileStateDatabaseFile(profileId, userDataPath)
      mkdirSync(join(userDataPath, 'profiles', profileId), { recursive: true })
      const opened = openProfileStateDatabase(databaseFile, profileId)
      try {
        importProfileStateJson(
          opened.db,
          JSON.stringify({ settings: { agentStatusHooksEnabled: true } })
        )
      } finally {
        opened.db.close()
      }
      getDefaultUserDataPathMock.mockReturnValue(userDataPath)
      if (reachable) {
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
        // The running app has turned hooks off but not yet written it to disk.
        callMock.mockResolvedValueOnce({
          id: 'settings',
          ok: true,
          result: { settings: { agentStatusHooksEnabled: false } },
          _meta: { runtimeId: 'runtime-1' }
        })
      }

      await main(['agent', 'hooks', 'status', '--json'], userDataPath)

      const payload: unknown = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
      expect(payload).toMatchObject({
        result: { enabled, appliedBy, settingsPath: databaseFile }
      })
    }
  )
})
