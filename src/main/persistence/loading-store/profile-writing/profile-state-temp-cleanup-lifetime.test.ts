import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../../../shared/windows-transient-lock-removal'
import * as durableFileWrite from '../../../filesystem/durable-file-write'
import { STALE_DURABLE_WRITE_TEMP_AGE_MS } from '../../tracking-repos/worktree-metadata-normalization'
import './profile-state-maintenance-fixture'
import { Store } from '../store'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTreeSync(directory)
  }
})

it('leaves legacy source temp files untouched when constructing a frozen importer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-import-temp-cleanup-'))
  directories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const source = '{"settings":{"theme":"dark"}}'
  const staleTempFile = `${dataFile}.99999999.0.import.tmp`
  writeFileSync(dataFile, source)
  writeFileSync(staleTempFile, 'retained temp bytes')
  const staleSeconds = (Date.now() - STALE_DURABLE_WRITE_TEMP_AGE_MS - 60_000) / 1000
  utimesSync(staleTempFile, staleSeconds, staleSeconds)
  const cleanup = vi.spyOn(durableFileWrite, 'removeStaleDurableWriteTempFiles')

  const imported = new Store({ dataFile, serializedState: source })
  expect(JSON.parse(imported.prepareProfileStateExport().json).settings.theme).toBe('dark')
  imported.freezeWrites()
  await Promise.all(
    cleanup.mock.results.map((result) => (result.type === 'return' ? result.value : undefined))
  )

  expect(cleanup.mock.calls.some(([file]) => file === dataFile)).toBe(false)
  expect(readFileSync(dataFile, 'utf8')).toBe(source)
  expect(readFileSync(staleTempFile, 'utf8')).toBe('retained temp bytes')
})
