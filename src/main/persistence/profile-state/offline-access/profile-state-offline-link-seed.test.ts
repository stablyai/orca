import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DomainWrites from '../documents/profile-state-domain-writes'

const concurrent = vi.hoisted(() => ({ write: null as null | (() => void) }))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../documents/profile-state-domain-writes', async (importOriginal) => {
  const real = await importOriginal<typeof DomainWrites>()
  return {
    ...real,
    // Lets one test land another writer's commit between the fenced read and this write.
    writeProfileStateDomain: (...args: Parameters<typeof real.writeProfileStateDomain>) => {
      concurrent.write?.()
      concurrent.write = null
      return real.writeProfileStateDomain(...args)
    }
  }
})

import {
  exportProfileStateJson,
  importProfileStateJson
} from '../documents/profile-state-documents'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../database/profile-state-database'
import { updateAgentHookSettingsFromProfileState } from './profile-state-offline-settings'

const TELEMETRY = { optedIn: true, installId: 'install-1', existedBeforeTelemetryRelease: false }
const SEED = { httpLinkClickBehavior: 'open', openLinksInAppPreferencePrompted: true }
let dir = ''
const location = () => ({
  dataFile: join(dir, 'orca-data.json'),
  databaseFile: join(dir, 'profile-state.db'),
  profileId: 'p'
})

function writeDb(root: unknown): void {
  mkdirSync(dir, { recursive: true })
  const opened = openProfileStateDatabase(location().databaseFile, 'p')
  try {
    if (root !== undefined) {
      importProfileStateJson(opened.db, JSON.stringify(root))
    }
  } finally {
    opened.db.close()
  }
}

function stored(): Record<string, unknown> & { settings: Record<string, unknown> } {
  const opened = openProfileStateDatabaseReadOnly(location().databaseFile, 'p')
  try {
    return JSON.parse(exportProfileStateJson(opened.db))
  } finally {
    opened.db.close()
  }
}

describe('offline agent-hook writes on a profile that was never opened', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-offline-link-seed-'))
    concurrent.write = null
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('seeds a profile with no state', () => {
    updateAgentHookSettingsFromProfileState(location(), false)
    expect(stored().settings).toMatchObject({ ...SEED, agentStatusHooksEnabled: false })
  })

  it('treats an admitted revision-0 database as absent', () => {
    writeDb(undefined)
    updateAgentHookSettingsFromProfileState(location(), false)
    expect(stored().settings).toMatchObject(SEED)
  })

  it('seeds telemetry-only state from JSON or SQLite and keeps its telemetry', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(location().dataFile, JSON.stringify({ settings: { telemetry: TELEMETRY } }))
    updateAgentHookSettingsFromProfileState(location(), false)
    expect(stored().settings).toMatchObject({ ...SEED, telemetry: TELEMETRY })
  })

  it('does not seed a non-zero-revision empty root or settings beside another domain', () => {
    writeDb({})
    updateAgentHookSettingsFromProfileState(location(), false)
    expect(stored().settings.httpLinkClickBehavior).toBeUndefined()

    rmSync(dir, { recursive: true, force: true })
    writeDb({ settings: { telemetry: TELEMETRY }, projectGroups: [{ id: 'g' }] })
    updateAgentHookSettingsFromProfileState(location(), false)
    expect(stored().settings.httpLinkClickBehavior).toBeUndefined()
    expect(stored().projectGroups).toEqual([{ id: 'g' }])
  })

  it('preserves saved link, legacy and other domain values', () => {
    const settings = {
      telemetry: TELEMETRY,
      httpLinkClickBehavior: 'ask',
      openLinksInApp: true,
      terminalLinkClickBehavior: 'open'
    }
    const repos = [{ id: 'repo-1', path: '/w' }]
    writeDb({ settings, repos })
    updateAgentHookSettingsFromProfileState(location(), false)
    expect(stored().settings).toMatchObject(settings)
    expect(stored().repos).toEqual(repos)
  })

  it('refuses when another writer committed after the read, leaving that commit intact', () => {
    writeDb({ settings: { telemetry: TELEMETRY } })
    concurrent.write = () => {
      const opened = openProfileStateDatabase(location().databaseFile, 'p')
      try {
        importProfileStateJson(
          opened.db,
          JSON.stringify({ settings: { telemetry: TELEMETRY, theme: 'dark' } })
        )
      } finally {
        opened.db.close()
      }
    }
    expect(() => updateAgentHookSettingsFromProfileState(location(), false)).toThrowError(
      expect.objectContaining({ code: 'profile-state-revision-conflict' })
    )
    expect(stored()).toEqual({ settings: { telemetry: TELEMETRY, theme: 'dark' } })
  })

  it('refuses through the authoritative reader when an unrelated domain is corrupt', () => {
    writeDb({ settings: { telemetry: TELEMETRY }, repos: [] })
    const opened = openProfileStateDatabase(location().databaseFile, 'p')
    try {
      opened.db
        .prepare(`UPDATE profile_state_documents SET payload = '{"x":' WHERE domain = 'repos'`)
        .run()
    } finally {
      opened.db.close()
    }
    expect(() => updateAgentHookSettingsFromProfileState(location(), false)).toThrow()
    const readOnly = openProfileStateDatabaseReadOnly(location().databaseFile, 'p')
    try {
      const row: unknown = readOnly.db
        .prepare(`SELECT payload FROM profile_state_documents WHERE domain = 'settings'`)
        .get()
      expect(row).toEqual({ payload: JSON.stringify({ telemetry: TELEMETRY }) })
    } finally {
      readOnly.db.close()
    }
  })
})
