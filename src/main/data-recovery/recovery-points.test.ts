import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PRE_RESTORE_SAFETY_SUFFIX,
  RETIRED_BACKUP_SUFFIX,
  listRecoveryPoints,
  restoreRecoveryPoint
} from './recovery-points'

const PINNED_SUFFIX = '.pre-agent-catalog-v1.backup'

describe('data recovery points', () => {
  let dir = ''
  let dataFile = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-data-recovery-'))
    dataFile = join(dir, 'orca-data.json')
  })

  afterEach(() => {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  })

  function backupRingPaths(): string[] {
    return Array.from({ length: 5 }, (_, index) => `${dataFile}.bak.${index}`)
  }

  function makeStore() {
    return {
      getDataFilePath: () => dataFile,
      getBackupRingFilePaths: () => backupRingPaths(),
      freezeWrites: vi.fn(),
      unfreezeWrites: vi.fn(),
      waitForPendingWrite: vi.fn(() => Promise.resolve())
    }
  }

  it('lists no points when no backup exists', () => {
    expect(listRecoveryPoints(dataFile)).toEqual([])
  })

  it('lists the pinned pre-v1 point with metadata only — no path, no contents', () => {
    writeFileSync(`${dataFile}${PINNED_SUFFIX}`, JSON.stringify({ settings: {} }))
    const points = listRecoveryPoints(dataFile)
    expect(points).toHaveLength(1)
    expect(points[0].id).toBe('agent-catalog-pre-v1')
    expect(points[0].compatibility).toBe('previous-binary')
    expect(points[0].sizeBytes).toBeGreaterThan(0)
    expect(points[0].createdAtMs).toBeGreaterThan(0)
    expect(JSON.stringify(points)).not.toContain(dir)
    expect(JSON.stringify(points)).not.toContain('settings')
    expect(points[0].restorable).toBe(true)
  })

  it('lists an unreadable pinned backup as not restorable', () => {
    // A directory at the backup path reproduces EISDIR everywhere; existence alone
    // would otherwise advertise a rollback the restore path always rejects.
    mkdirSync(`${dataFile}${PINNED_SUFFIX}`)
    const points = listRecoveryPoints(dataFile)
    expect(points).toHaveLength(1)
    expect(points[0].restorable).toBe(false)
  })

  it('lists a torn pinned backup as not restorable', () => {
    writeFileSync(`${dataFile}${PINNED_SUFFIX}`, '{"settings":')
    expect(listRecoveryPoints(dataFile)[0].restorable).toBe(false)
  })

  it('restores atomically: freeze before replace, safety copy kept, point preserved', async () => {
    const preV1 = JSON.stringify({ settings: { defaultTuiAgent: null } })
    const current = JSON.stringify({ settings: { agentCatalogSchemaVersion: 1 } })
    writeFileSync(dataFile, current, { mode: 0o600 })
    writeFileSync(`${dataFile}${PINNED_SUFFIX}`, preV1, { mode: 0o600 })

    const store = makeStore()
    const result = await restoreRecoveryPoint(store, 'agent-catalog-pre-v1')

    expect(result).toEqual({ ok: true })
    expect(store.freezeWrites).toHaveBeenCalledTimes(1)
    expect(store.waitForPendingWrite).toHaveBeenCalledTimes(1)
    expect(store.unfreezeWrites).not.toHaveBeenCalled()
    // Byte-identical restore; the point and a safety copy of the v1 file both survive.
    expect(readFileSync(dataFile, 'utf-8')).toBe(preV1)
    expect(readFileSync(`${dataFile}${PINNED_SUFFIX}`, 'utf-8')).toBe(preV1)
    expect(readFileSync(`${dataFile}${PRE_RESTORE_SAFETY_SUFFIX}`, 'utf-8')).toBe(current)
    expect(statSync(dataFile).mode & 0o777).toBe(0o600)
  })

  // The older binary's load-time fallback restores any `.bak.N` slot that parses,
  // so a ring left in place would silently resurrect the discarded v1 state.
  it('retires the rotating backup ring so a downgraded binary cannot restore v1 state', async () => {
    const preV1 = JSON.stringify({ settings: { defaultTuiAgent: null } })
    writeFileSync(dataFile, JSON.stringify({ settings: { agentCatalogSchemaVersion: 1 } }))
    writeFileSync(`${dataFile}${PINNED_SUFFIX}`, preV1)
    const slots = backupRingPaths()
    writeFileSync(slots[0], '{"settings":{"agentCatalogSchemaVersion":1}}')
    writeFileSync(slots[3], '{"settings":{"agentCatalogSchemaVersion":1,"other":true}}')

    const result = await restoreRecoveryPoint(makeStore(), 'agent-catalog-pre-v1')

    expect(result).toEqual({ ok: true })
    for (const slot of slots) {
      expect(existsSync(slot), slot).toBe(false)
    }
    // Renamed, not deleted: the bytes stay recoverable by hand.
    expect(readFileSync(`${slots[0]}${RETIRED_BACKUP_SUFFIX}`, 'utf-8')).toBe(
      '{"settings":{"agentCatalogSchemaVersion":1}}'
    )
    expect(readFileSync(`${slots[3]}${RETIRED_BACKUP_SUFFIX}`, 'utf-8')).toBe(
      '{"settings":{"agentCatalogSchemaVersion":1,"other":true}}'
    )
    expect(existsSync(`${slots[1]}${RETIRED_BACKUP_SUFFIX}`)).toBe(false)
    expect(readFileSync(dataFile, 'utf-8')).toBe(preV1)
  })

  it('rejects a missing point without touching anything', async () => {
    writeFileSync(dataFile, '{}')
    const store = makeStore()
    const result = await restoreRecoveryPoint(store, 'agent-catalog-pre-v1')
    expect(result.ok).toBe(false)
    expect(store.freezeWrites).not.toHaveBeenCalled()
    expect(readFileSync(dataFile, 'utf-8')).toBe('{}')
  })

  it('rejects a corrupt backup before suspending writes', async () => {
    writeFileSync(dataFile, '{"settings":{}}')
    writeFileSync(`${dataFile}${PINNED_SUFFIX}`, 'not json {')
    const store = makeStore()
    const result = await restoreRecoveryPoint(store, 'agent-catalog-pre-v1')
    expect(result.ok).toBe(false)
    expect(store.freezeWrites).not.toHaveBeenCalled()
    expect(readFileSync(dataFile, 'utf-8')).toBe('{"settings":{}}')
    expect(existsSync(`${dataFile}${PRE_RESTORE_SAFETY_SUFFIX}`)).toBe(false)
  })

  // Why skip on win32: chmod cannot make a directory read-only on Windows.
  it.skipIf(process.platform === 'win32')(
    're-enables writes and leaves the live file intact when the replace fails',
    async () => {
      const current = '{"settings":{"agentCatalogSchemaVersion":1}}'
      writeFileSync(dataFile, current, { mode: 0o600 })
      writeFileSync(`${dataFile}${PINNED_SUFFIX}`, '{"settings":{}}', { mode: 0o600 })
      const store = makeStore()
      // Read-only directory: the safety-copy tmp file cannot be created.
      chmodSync(dir, 0o500)
      const result = await restoreRecoveryPoint(store, 'agent-catalog-pre-v1')
      chmodSync(dir, 0o755)
      expect(result.ok).toBe(false)
      expect(store.freezeWrites).toHaveBeenCalledTimes(1)
      expect(store.unfreezeWrites).toHaveBeenCalledTimes(1)
      expect(readFileSync(dataFile, 'utf-8')).toBe(current)
    }
  )
})
