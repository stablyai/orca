import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getWatcherProcessEntryPath } from '../ipc/filesystem/watcher-process/parcel-watcher-entry-path'
import { AI_VAULT_SERVICE_ENTRY_FILENAME } from '../ai-vault/scan-service/session-scanner-service-entry-path'
import { FOREIGN_SQLITE_READER_ENTRY_FILENAME } from '../foreign-sqlite-readers/foreign-sqlite-reader-entry-path'
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
})
