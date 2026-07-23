import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateLegacyManagedCodexStateSync } from './legacy-managed-state-migration'

describe('Codex legacy managed-state migration', () => {
  let root = ''
  let managedAccountsRoot = ''
  let metadataDir = ''
  let runtimeHomePath = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-managed-state-'))
    managedAccountsRoot = join(root, 'codex-accounts')
    metadataDir = join(root, 'metadata')
    runtimeHomePath = join(root, 'runtime')
    mkdirSync(managedAccountsRoot)
    mkdirSync(metadataDir)
    mkdirSync(runtimeHomePath)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  function createManagedHome(accountId: string): string {
    const homePath = join(managedAccountsRoot, accountId, 'home')
    mkdirSync(homePath, { recursive: true })
    writeFileSync(join(homePath, '.orca-managed-home'), '')
    return homePath
  }

  function migrate(
    limits?: Parameters<typeof migrateLegacyManagedCodexStateSync>[0]['limits']
  ): ReturnType<typeof migrateLegacyManagedCodexStateSync> {
    return migrateLegacyManagedCodexStateSync({
      managedAccountsRoot,
      metadataDir,
      runtimeHomePath,
      limits
    })
  }

  it('preserves ordinary history, session, diagnostic, and one-shot marker behavior', () => {
    const homePath = createManagedHome('account-1')
    writeFileSync(join(runtimeHomePath, 'history.jsonl'), '{"id":"shared"}\n')
    writeFileSync(join(homePath, 'history.jsonl'), '{"id":"shared"}\n{"id":"managed"}\n')
    mkdirSync(join(homePath, 'sessions'))
    mkdirSync(join(runtimeHomePath, 'sessions'))
    writeFileSync(join(homePath, 'sessions', 'conflict.jsonl'), 'legacy\n')
    writeFileSync(join(runtimeHomePath, 'sessions', 'conflict.jsonl'), 'runtime\n')

    const summary = migrate()

    expect(summary).toMatchObject({
      diagnosticRecordsOmitted: 0,
      diagnosticRecordsWritten: 1,
      historySkippedHomeCount: 0,
      managedHomeDiscoverySkipped: false,
      migratedHomeCount: 1,
      sessionSkippedHomeCount: 0
    })
    expect(readFileSync(join(runtimeHomePath, 'history.jsonl'), 'utf8')).toBe(
      '{"id":"shared"}\n{"id":"managed"}\n'
    )
    expect(
      readFileSync(
        join(runtimeHomePath, 'sessions', 'conflict.orca-legacy-account-1.jsonl'),
        'utf8'
      )
    ).toBe('legacy\n')
    const diagnostic = readFileSync(join(metadataDir, 'migration-diagnostics.jsonl'), 'utf8')
    expect(diagnostic).toContain('"type":"session-conflict"')

    const marker = JSON.parse(readFileSync(join(metadataDir, 'migration-v1.json'), 'utf8'))
    expect(Object.keys(marker).sort()).toEqual(['completedAt', 'migratedHomeCount'])
    expect(marker.migratedHomeCount).toBe(1)
    expect(migrate()).toBeNull()
  })

  it('skips all homes deterministically when managed-home discovery exceeds its cap', () => {
    const firstHome = createManagedHome('account-1')
    createManagedHome('account-2')
    writeFileSync(join(firstHome, 'history.jsonl'), '{"id":"must-not-import"}\n')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = migrate({ maxAccountEntries: 1 })

    expect(summary).toMatchObject({
      managedHomeDiscoverySkipped: true,
      migratedHomeCount: 0
    })
    expect(existsSync(join(runtimeHomePath, 'history.jsonl'))).toBe(false)
    const marker = JSON.parse(readFileSync(join(metadataDir, 'migration-v1.json'), 'utf8'))
    expect(marker).toMatchObject({
      managedHomeDiscoverySkipped: true,
      migratedHomeCount: 0
    })
    expect(readFileSync(join(metadataDir, 'migration-diagnostics.jsonl'), 'utf8')).toContain(
      '"type":"managed-home-discovery-skipped"'
    )
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('records history and session capacity skips without partial output', () => {
    const homePath = createManagedHome('account-1')
    writeFileSync(join(homePath, 'history.jsonl'), 'oversized\n')
    mkdirSync(join(homePath, 'sessions'))
    writeFileSync(join(homePath, 'sessions', 'a.jsonl'), 'a')
    writeFileSync(join(homePath, 'sessions', 'b.jsonl'), 'b')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = migrate({
      history: { maxFileBytes: 4 },
      sessions: { maxEntries: 1 }
    })

    expect(summary).toMatchObject({
      historySkippedHomeCount: 1,
      sessionSkippedHomeCount: 1
    })
    expect(existsSync(join(runtimeHomePath, 'history.jsonl'))).toBe(false)
    expect(existsSync(join(runtimeHomePath, 'sessions'))).toBe(false)
    const marker = JSON.parse(readFileSync(join(metadataDir, 'migration-v1.json'), 'utf8'))
    expect(marker).toMatchObject({
      historySkippedHomeCount: 1,
      sessionSkippedHomeCount: 1
    })
    const diagnostics = readFileSync(join(metadataDir, 'migration-diagnostics.jsonl'), 'utf8')
    expect(diagnostics).toContain('"type":"history-skipped"')
    expect(diagnostics).toContain('"type":"sessions-skipped"')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('caps diagnostic output while still preserving every conflicting session', () => {
    const homePath = createManagedHome('account-1')
    mkdirSync(join(homePath, 'sessions'))
    mkdirSync(join(runtimeHomePath, 'sessions'))
    for (const name of ['a.jsonl', 'b.jsonl']) {
      writeFileSync(join(homePath, 'sessions', name), `legacy-${name}`)
      writeFileSync(join(runtimeHomePath, 'sessions', name), `runtime-${name}`)
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = migrate({ maxDiagnosticRecords: 1 })

    expect(summary).toMatchObject({
      diagnosticRecordsOmitted: 1,
      diagnosticRecordsWritten: 1
    })
    expect(existsSync(join(runtimeHomePath, 'sessions', 'a.orca-legacy-account-1.jsonl'))).toBe(
      true
    )
    expect(existsSync(join(runtimeHomePath, 'sessions', 'b.orca-legacy-account-1.jsonl'))).toBe(
      true
    )
    const marker = JSON.parse(readFileSync(join(metadataDir, 'migration-v1.json'), 'utf8'))
    expect(marker.diagnosticRecordsOmitted).toBe(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
