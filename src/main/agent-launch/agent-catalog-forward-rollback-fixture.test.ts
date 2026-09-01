// End-to-end forward-rollback fixture on a DISPOSABLE profile (plan §1021-1028,
// oracle 39). The unit migration tests own field mapping; this fixture proves the
// operational contract: migrate v0→v1, exercise a v1 reference through the real
// resolver, confirm a forward-rollback build still resolves saved identities, and
// restore the pinned pre-v1 backup as the only supported downgrade. Never touches
// user data — every path is under a fresh mkdtemp dir removed in afterEach.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CustomTuiAgentId, GlobalSettings } from '../../shared/types'
import {
  AGENT_CATALOG_SCHEMA_VERSION,
  migrateAgentCatalogSchema
} from '../../shared/agent-catalog-schema-migration'
import { createPinnedPreV1Backup, pinnedPreV1BackupPath } from './agent-catalog-pre-v1-backup'
import { resolveAgentLaunch } from './resolve-agent-launch'
import {
  catalogOf,
  customAgent,
  customId,
  requestOf,
  settingsOf
} from './agent-launch-test-catalog'

let dir: string
let dataFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-agent-catalog-forward-rollback-'))
  dataFile = join(dir, 'orca-settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A v0 profile: no schema version, shipped legacy `defaultTuiAgent: null` (Auto),
 *  and one saved custom identity that must keep resolving across the migration. */
function writeV0Profile(): {
  v0Raw: string
  v0Settings: Partial<GlobalSettings>
  customId: CustomTuiAgentId
} {
  const custom = customAgent({
    id: customId('codex'),
    baseAgent: 'codex',
    label: 'Prod Codex',
    args: '--model o3'
  })
  const v0Settings: Partial<GlobalSettings> = {
    customTuiAgents: [custom],
    deletedCustomTuiAgents: [],
    defaultTuiAgent: null
  }
  const v0Raw = JSON.stringify(v0Settings, null, 2)
  writeFileSync(dataFile, v0Raw, { mode: 0o600 })
  return { v0Raw, v0Settings, customId: custom.id }
}

function savedIdentityResolves(settings: Partial<GlobalSettings>, id: CustomTuiAgentId): boolean {
  const catalog = catalogOf({ customTuiAgents: settings.customTuiAgents ?? [] })
  return resolveAgentLaunch(
    requestOf({ selection: { kind: 'agent', agent: id } }),
    catalog,
    settingsOf()
  ).ok
}

describe('agent catalog forward-rollback fixture (disposable profile)', () => {
  it('migrates v0→v1, pins a same-permission backup, and resolves a v1 reference', () => {
    const { v0Raw, v0Settings, customId: savedId } = writeV0Profile()
    const before = statSync(dataFile).mode & 0o777

    const outcome = migrateAgentCatalogSchema({
      settings: v0Settings,
      preV1RawContents: v0Raw,
      createBackup: () => createPinnedPreV1Backup(dataFile, v0Raw)
    })

    expect(outcome.didMigrate).toBe(true)
    expect(outcome.backupError).toBeUndefined()
    expect(outcome.settingsPatch.agentCatalogSchemaVersion).toBe(AGENT_CATALOG_SCHEMA_VERSION)
    expect(outcome.settingsPatch.defaultTuiAgent).toBe('auto')

    // The pinned backup is a byte-exact, same-permission copy of the pre-v1 file.
    const backupFile = pinnedPreV1BackupPath(dataFile)
    expect(existsSync(backupFile)).toBe(true)
    expect(readFileSync(backupFile, 'utf8')).toBe(v0Raw)
    expect(statSync(backupFile).mode & 0o777).toBe(before)

    // Exercise a v1 reference: the migrated custom identity resolves.
    const migrated: Partial<GlobalSettings> = { ...v0Settings, ...outcome.settingsPatch }
    expect(savedIdentityResolves(migrated, savedId)).toBe(true)
  })

  it('a forward-rollback build keeps resolving already-saved identities (v1 stays a no-op)', () => {
    const { v0Raw, v0Settings, customId: savedId } = writeV0Profile()
    const first = migrateAgentCatalogSchema({
      settings: v0Settings,
      preV1RawContents: v0Raw,
      createBackup: () => createPinnedPreV1Backup(dataFile, v0Raw)
    })
    const migrated: Partial<GlobalSettings> = { ...v0Settings, ...first.settingsPatch }
    const v1Raw = JSON.stringify(migrated, null, 2)
    writeFileSync(dataFile, v1Raw, { mode: 0o600 })

    // A forward-rollback build re-loads the v1 file: migration is a no-op (already
    // stamped), and it never disables identity resolution for saved defaults/agents.
    const v1Settings = JSON.parse(readFileSync(dataFile, 'utf8')) as Partial<GlobalSettings>
    const reload = migrateAgentCatalogSchema({
      settings: v1Settings,
      preV1RawContents: v1Raw,
      createBackup: () => createPinnedPreV1Backup(dataFile, v1Raw)
    })
    expect(reload.didMigrate).toBe(false)
    expect(savedIdentityResolves(v1Settings, savedId)).toBe(true)
  })

  it('restores the pinned pre-v1 backup as the only supported downgrade (discards v1 metadata)', () => {
    const { v0Raw, v0Settings } = writeV0Profile()
    const outcome = migrateAgentCatalogSchema({
      settings: v0Settings,
      preV1RawContents: v0Raw,
      createBackup: () => createPinnedPreV1Backup(dataFile, v0Raw)
    })
    // Simulate the v1 write plus later v1-only metadata beyond the backup point.
    const migrated: Partial<GlobalSettings> = {
      ...v0Settings,
      ...outcome.settingsPatch,
      agentReferenceRevision: 7
    }
    writeFileSync(dataFile, JSON.stringify(migrated, null, 2), { mode: 0o600 })

    // Explicit user downgrade = restore the pinned backup over the data file.
    const backupRaw = readFileSync(pinnedPreV1BackupPath(dataFile), 'utf8')
    writeFileSync(dataFile, backupRaw, { mode: 0o600 })

    // Byte-identical pre-v1 state; the post-backup v1 metadata is intentionally gone.
    expect(readFileSync(dataFile, 'utf8')).toBe(v0Raw)
    const restored = JSON.parse(backupRaw) as Partial<GlobalSettings>
    expect(restored.agentCatalogSchemaVersion).toBeUndefined()
    expect(restored.agentReferenceRevision).toBeUndefined()
  })

  it('a crash after backup but before the v1 write leaves a complete, restorable v0 file (never half-migrated)', () => {
    const { v0Raw, v0Settings } = writeV0Profile()
    // The backup is created BEFORE any v1 write, so a crash mid-migration finds the
    // complete old file plus a usable backup — the oracle-39 boundary guarantee.
    const backup = createPinnedPreV1Backup(dataFile, v0Raw)
    expect(backup).toEqual({ ok: true, created: true })

    // Crash: no v1 patch is written. On-disk data file is still the complete v0.
    expect(readFileSync(dataFile, 'utf8')).toBe(v0Raw)
    const parsed = JSON.parse(readFileSync(dataFile, 'utf8')) as Partial<GlobalSettings>
    expect(parsed.agentCatalogSchemaVersion).toBeUndefined()

    // And the backup independently restores a complete v0 file.
    expect(readFileSync(pinnedPreV1BackupPath(dataFile), 'utf8')).toBe(v0Raw)

    // A restart re-runs the migration cleanly from the intact v0 state.
    const retry = migrateAgentCatalogSchema({
      settings: v0Settings,
      preV1RawContents: v0Raw,
      createBackup: () => createPinnedPreV1Backup(dataFile, v0Raw)
    })
    expect(retry.didMigrate).toBe(true)
    expect(retry.backupError).toBeUndefined()
  })
})
