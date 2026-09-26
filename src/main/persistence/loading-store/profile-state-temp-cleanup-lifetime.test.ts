import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../../shared/windows-transient-lock-removal'
import * as durableFileWrite from '../../durable-file-write'
import { STALE_DURABLE_WRITE_TEMP_AGE_MS } from '../tracking-repos/worktree-metadata-normalization'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'
import { Store } from './store'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTreeSync(directory)
  }
})

it.each(['maintenance', 'freeze', 'final'] as const)(
  '%s drains startup temp cleanup without delaying ordinary SQL writes',
  async (kind) => {
    const gate = maintenanceBarrier()
    const cleanup = durableFileWrite.removeStaleDurableWriteTempFiles
    vi.spyOn(durableFileWrite, 'removeStaleDurableWriteTempFiles').mockImplementation(
      (file, options) =>
        basename(file) === 'orca-data.json' ? gate.promise : cleanup(file, options)
    )
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    store.updateSettings({ theme: 'dark' })
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.theme).toBe('dark')

    const close = vi.spyOn(authority, 'close')
    const checkpoint = vi.spyOn(authority, 'writeCompleteSerializedDomains')
    const finished = vi.fn()
    const pending =
      kind === 'maintenance'
        ? store.beginProfileMaintenance()
        : kind === 'freeze'
          ? store.freezeWritesAsync()
          : store.flushFinalOrThrowAsync()
    void pending.then(finished, finished)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(finished).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(checkpoint).not.toHaveBeenCalled()

    gate.resolve()
    await pending
    expect(close).toHaveBeenCalledOnce()
  }
)

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
