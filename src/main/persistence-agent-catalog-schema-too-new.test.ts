// A profile stamped by a newer build must stay read-only: the Store latches the
// too-new state at load, refuses durable authoring writes, and never turns it
// into a retryable pinned-backup failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
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

describe('agent-catalog schema newer than this build', () => {
  let dir = ''
  let dataFile = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-agent-catalog-too-new-'))
    testState.dir = dir
    dataFile = join(dir, 'orca-data.json')
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('latches the too-new state at load without a retryable migration error', async () => {
    writeProfile(dataFile, {
      defaultTuiAgent: 'codex',
      agentCatalogSchemaVersion: 2,
      agentCatalogRevision: 7
    })
    const store = await createStore(dataFile)
    expect(store.getAgentCatalogSchemaTooNew()).toEqual({
      persistedVersion: 2,
      supportedVersion: 1
    })
    // A too-new profile is not a blocked migration: retrying a backup fixes nothing.
    expect(store.getAgentCatalogMigrationError()).toBeNull()
    expect(store.retryAgentCatalogMigration()).toEqual({ ok: true })
    expect(store.getSettings().agentCatalogSchemaVersion).toBe(2)
    expect(store.getSettings().agentCatalogRevision).toBe(7)
    expect(existsSync(`${dataFile}${PINNED_BACKUP_SUFFIX}`)).toBe(false)
  })

  it('refuses durable authoring writes while the profile is too new', async () => {
    writeProfile(dataFile, {
      agentCatalogSchemaVersion: 3,
      defaultTuiAgent: 'codex'
    })
    const store = await createStore(dataFile)
    expect(() => store.updateSettingsDurable({ defaultTuiAgent: 'auto' })).toThrow(
      /newer than this build supports/
    )
    expect(store.getSettings().defaultTuiAgent).toBe('codex')
  })

  // The read-only latch only gates the two authoring services and
  // updateSettingsDurable. Every other mutation path schedules a full-file
  // rewrite from the v1 in-memory model, whose normalizers dropped the v2
  // fields — so the profile must be frozen outright, not merely flagged.
  it('freezes all writes, not just the authoring paths, while the profile is too new', async () => {
    writeProfile(dataFile, {
      defaultTuiAgent: 'codex',
      agentCatalogSchemaVersion: 2,
      agentCatalogRevision: 7,
      unknownFutureSetting: 'must survive'
    })
    const store = await createStore(dataFile)

    store.updateSettings({ defaultTuiAgent: 'auto' })
    await store.waitForPendingWrite()

    const onDisk = JSON.parse(readFileSync(dataFile, 'utf-8')) as {
      settings: Record<string, unknown>
    }
    expect(onDisk.settings.unknownFutureSetting).toBe('must survive')
    expect(onDisk.settings.agentCatalogSchemaVersion).toBe(2)
    expect(onDisk.settings.defaultTuiAgent).toBe('codex')
  })

  // A failed recovery-point restore rolls the freeze back. That rollback is about
  // a stale in-memory copy of a compatible file; it must not re-enable writes
  // against a profile this build cannot represent.
  it('does not let a failed restore rollback lift the too-new freeze', async () => {
    writeProfile(dataFile, {
      defaultTuiAgent: 'codex',
      agentCatalogSchemaVersion: 2,
      unknownFutureSetting: 'must survive'
    })
    const store = await createStore(dataFile)

    store.unfreezeWrites()
    store.updateSettings({ defaultTuiAgent: 'auto' })
    await store.waitForPendingWrite()

    const onDisk = JSON.parse(readFileSync(dataFile, 'utf-8')) as {
      settings: Record<string, unknown>
    }
    expect(onDisk.settings.unknownFutureSetting).toBe('must survive')
  })

  it('allows durable authoring writes on a supported profile', async () => {
    writeProfile(dataFile, {
      defaultTuiAgent: 'codex',
      agentCatalogSchemaVersion: 1,
      agentCatalogRevision: 1,
      agentReferenceRevision: 1
    })
    const store = await createStore(dataFile)
    expect(store.getAgentCatalogSchemaTooNew()).toBeNull()
    expect(store.updateSettingsDurable({ defaultTuiAgent: 'auto' }).defaultTuiAgent).toBe('auto')
  })

  // Why skip on win32: chmod cannot make a directory read-only on Windows.
  it.skipIf(process.platform === 'win32')(
    'converts a blocked migration retry into read-only when the profile turned out newer',
    async () => {
      writeFileSync(dataFile, JSON.stringify({ settings: { defaultTuiAgent: null } }), {
        mode: 0o600
      })
      chmodSync(dir, 0o500)
      const store = await createStore(dataFile)
      chmodSync(dir, 0o755)
      expect(store.getAgentCatalogMigrationError()).not.toBeNull()

      // A newer build's stamp reached this session (e.g. a synced profile) while
      // the pinned backup was still owed.
      store.updateSettings({ agentCatalogSchemaVersion: 4 })
      const retry = store.retryAgentCatalogMigration()
      expect(retry.ok).toBe(false)
      expect(retry.ok === false && retry.error).toMatch(/read-only/)
      expect(store.getAgentCatalogSchemaTooNew()).toEqual({
        persistedVersion: 4,
        supportedVersion: 1
      })
      // The retryable error is dropped: nothing about a backup can make it writable.
      expect(store.getAgentCatalogMigrationError()).toBeNull()
      expect(existsSync(`${dataFile}${PINNED_BACKUP_SUFFIX}`)).toBe(false)
    }
  )
})
