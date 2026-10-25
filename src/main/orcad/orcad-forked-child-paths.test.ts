import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAppEnvironment } from '../../shared/app-environment'
import { getWatcherProcessEntryPath } from '../ipc/filesystem/watcher-process/parcel-watcher-entry-path'
import {
  AI_VAULT_SERVICE_ENTRY_FILENAME,
  getAiVaultServiceEntryPath
} from '../ai-vault/session-scanner-service-entry-path'
import {
  FOREIGN_SQLITE_READER_ENTRY_FILENAME,
  resolveForeignSqliteReaderEntryPath
} from '../foreign-sqlite-readers/foreign-sqlite-reader-entry-path'
import { currentWorkerEntryLayout } from '../worker-thread-entry-path'
import { installOrcadHostAdapters } from './orcad-host-adapters'

// Compose real adapters and deployment paths: isolated resolver tests missed nonexistent fork targets.
describe('orcad forked-child paths', () => {
  let deployRoot: string
  let originalArgv: string[]

  beforeEach(() => {
    deployRoot = mkdtempSync(join(tmpdir(), 'orcad-deploy-'))
    writeFileSync(join(deployRoot, 'orcad.js'), '')
    writeFileSync(join(deployRoot, 'parcel-watcher-process-entry.js'), '')
    writeFileSync(join(deployRoot, FOREIGN_SQLITE_READER_ENTRY_FILENAME), '')
    writeFileSync(join(deployRoot, AI_VAULT_SERVICE_ENTRY_FILENAME), '')
    originalArgv = process.argv
    process.argv = [process.execPath, join(deployRoot, 'orcad.js')]
    installOrcadHostAdapters()
  })

  afterEach(() => {
    process.argv = originalArgv
    rmSync(deployRoot, { recursive: true, force: true })
  })

  it('forks the watcher child shipped beside orcad.js', () => {
    expect(getWatcherProcessEntryPath()).toBe(join(deployRoot, 'parcel-watcher-process-entry.js'))
  })

  it('forks the session scanner child shipped beside orcad.js', () => {
    expect(getAiVaultServiceEntryPath()).toBe(join(deployRoot, AI_VAULT_SERVICE_ENTRY_FILENAME))
  })

  it('starts the foreign SQLite reader worker shipped beside orcad.js', () => {
    expect(resolveForeignSqliteReaderEntryPath(currentWorkerEntryLayout(deployRoot))).toBe(
      join(deployRoot, FOREIGN_SQLITE_READER_ENTRY_FILENAME)
    )
  })

  it('ignores a decoy child under the working directory', () => {
    // Cwd may hold an unrelated build; only the install root establishes shipped children.
    const elsewhere = mkdtempSync(join(tmpdir(), 'orcad-cwd-'))
    mkdirSync(join(elsewhere, 'out', 'main'), { recursive: true })
    writeFileSync(join(elsewhere, 'out', 'main', 'parcel-watcher-process-entry.js'), '')
    writeFileSync(join(elsewhere, 'parcel-watcher-process-entry.js'), '')
    const originalCwd = process.cwd()
    process.chdir(elsewhere)
    try {
      expect(getWatcherProcessEntryPath()).toBe(join(deployRoot, 'parcel-watcher-process-entry.js'))
    } finally {
      process.chdir(originalCwd)
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('reports the install root and the Node binary, not the data directory', () => {
    const environment = getAppEnvironment()
    expect(environment.getAppPath()).toBe(deployRoot)
    expect(environment.getPath('exe')).toBe(process.execPath)
    expect(environment.getPath('exe')).not.toBe(environment.getPath('userData'))
  })
})
