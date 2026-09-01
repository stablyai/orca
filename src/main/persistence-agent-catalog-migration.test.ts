// Store-level round trip for the agent-catalog v1 schema migration: legacy
// Auto mapping, pinned pre-v1 backup, idempotence, backup-failure fail-closed
// behavior, and post-v1 repair-null preservation.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => null),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

async function createStore(dataFile: string) {
  vi.resetModules()
  const { Store } = await import('./persistence')
  return new Store({ dataFile })
}

function writeProfile(dataFile: string, settings: Record<string, unknown>): void {
  writeFileSync(dataFile, JSON.stringify({ settings }), { mode: 0o600 })
}

const PINNED_BACKUP_SUFFIX = '.pre-agent-catalog-v1.backup'

describe('agent-catalog v1 migration through the real Store', () => {
  let dir = ''
  let dataFile = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-agent-catalog-store-'))
    testState.dir = dir
    dataFile = join(dir, 'orca-data.json')
  })

  afterEach(() => {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  })

  it('maps a shipped legacy null default to auto once, pinning a same-permission backup', async () => {
    const original = JSON.stringify({ settings: { defaultTuiAgent: null } })
    writeFileSync(dataFile, original, { mode: 0o600 })
    const store = await createStore(dataFile)
    expect(store.getSettings().defaultTuiAgent).toBe('auto')
    expect(store.getSettings().agentCatalogSchemaVersion).toBe(1)
    expect(store.getAgentCatalogMigrationError()).toBeNull()

    const backupFile = `${dataFile}${PINNED_BACKUP_SUFFIX}`
    expect(existsSync(backupFile)).toBe(true)
    expect(readFileSync(backupFile, 'utf-8')).toBe(original)
    expect(statSync(backupFile).mode & 0o777).toBe(0o600)
  })

  it('preserves an explicit blank or concrete default while stamping v1', async () => {
    for (const explicit of ['blank', 'codex']) {
      const file = join(dir, `orca-data-${explicit}.json`)
      writeProfile(file, { defaultTuiAgent: explicit })
      const store = await createStore(file)
      expect(store.getSettings().defaultTuiAgent).toBe(explicit)
      expect(store.getSettings().agentCatalogSchemaVersion).toBe(1)
    }
  })

  it('is idempotent: a second load neither remaps nor rewrites the backup', async () => {
    const original = JSON.stringify({ settings: { defaultTuiAgent: null } })
    writeFileSync(dataFile, original, { mode: 0o600 })
    const first = await createStore(dataFile)
    expect(first.getSettings().defaultTuiAgent).toBe('auto')
    // Simulate the post-migration persisted file, then load again.
    writeProfile(dataFile, {
      defaultTuiAgent: 'auto',
      agentCatalogSchemaVersion: 1,
      agentCatalogRevision: 1,
      agentReferenceRevision: 1
    })
    const second = await createStore(dataFile)
    expect(second.getSettings().defaultTuiAgent).toBe('auto')
    expect(readFileSync(`${dataFile}${PINNED_BACKUP_SUFFIX}`, 'utf-8')).toBe(original)
  })

  it('keeps a post-v1 repair null default as null (never re-Auto)', async () => {
    writeProfile(dataFile, {
      defaultTuiAgent: null,
      agentCatalogSchemaVersion: 1,
      agentCatalogRevision: 4,
      agentReferenceRevision: 2
    })
    const store = await createStore(dataFile)
    expect(store.getSettings().defaultTuiAgent).toBeNull()
    expect(store.getSettings().agentCatalogRevision).toBe(4)
    // No pinned backup is created for an already-v1 profile.
    expect(existsSync(`${dataFile}${PINNED_BACKUP_SUFFIX}`)).toBe(false)
  })

  it('performs no v1 write when the pinned backup cannot be created', async () => {
    writeFileSync(dataFile, JSON.stringify({ settings: { defaultTuiAgent: null } }), {
      mode: 0o600
    })
    // A read-only directory makes the backup tmp-file creation fail.
    chmodSync(dir, 0o500)
    const store = await createStore(dataFile)
    chmodSync(dir, 0o755)
    expect(store.getAgentCatalogMigrationError()).not.toBeNull()
    const settings = store.getSettings()
    // Legacy semantics stay intact: null still means Auto through the legacy
    // adapters, and no v1 marker or catalog array leaks into the state.
    expect(settings.defaultTuiAgent).toBeNull()
    expect(settings.agentCatalogSchemaVersion).toBeUndefined()
    expect(settings.agentCatalogRevision).toBeUndefined()
    expect(existsSync(`${dataFile}${PINNED_BACKUP_SUFFIX}`)).toBe(false)
  })

  it('gives a fresh install v1 defaults directly with no backup', async () => {
    const store = await createStore(dataFile)
    expect(store.getSettings().defaultTuiAgent).toBe('auto')
    expect(store.getSettings().agentCatalogSchemaVersion).toBe(1)
    expect(existsSync(`${dataFile}${PINNED_BACKUP_SUFFIX}`)).toBe(false)
  })

  // Why skip on win32: chmod cannot make a directory read-only on Windows.
  it.skipIf(process.platform === 'win32')(
    'retryAgentCatalogMigration completes a blocked migration once the cause clears',
    async () => {
      const original = JSON.stringify({ settings: { defaultTuiAgent: null } })
      writeFileSync(dataFile, original, { mode: 0o600 })
      chmodSync(dir, 0o500)
      const store = await createStore(dataFile)
      expect(store.getAgentCatalogMigrationError()).not.toBeNull()

      // Still failing: retry reports the error and stays pre-v1.
      const stillBlocked = store.retryAgentCatalogMigration()
      expect(stillBlocked.ok).toBe(false)
      expect(store.getAgentCatalogMigrationError()).not.toBeNull()
      expect(store.getSettings().agentCatalogSchemaVersion).toBeUndefined()

      chmodSync(dir, 0o755)
      const result = store.retryAgentCatalogMigration()
      expect(result).toEqual({ ok: true })
      expect(store.getAgentCatalogMigrationError()).toBeNull()
      expect(store.getSettings().agentCatalogSchemaVersion).toBe(1)
      expect(store.getSettings().defaultTuiAgent).toBe('auto')
      // The backup captured the untouched pre-v1 bytes before any v1 write.
      expect(readFileSync(`${dataFile}${PINNED_BACKUP_SUFFIX}`, 'utf-8')).toBe(original)
      store.flushOrThrow()
      const persisted = JSON.parse(readFileSync(dataFile, 'utf-8'))
      expect(persisted.settings.agentCatalogSchemaVersion).toBe(1)
    }
  )

  it('retryAgentCatalogMigration is a no-op when the migration is not blocked', async () => {
    writeFileSync(dataFile, JSON.stringify({ settings: { defaultTuiAgent: null } }), {
      mode: 0o600
    })
    const store = await createStore(dataFile)
    expect(store.getAgentCatalogMigrationError()).toBeNull()
    expect(store.retryAgentCatalogMigration()).toEqual({ ok: true })
    expect(store.getSettings().agentCatalogSchemaVersion).toBe(1)
  })
})
