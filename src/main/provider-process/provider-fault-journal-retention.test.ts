import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as GroupGuard from './provider-group-orphan-guard'
import type * as RowReader from './provider-process-row-read'
import type { ProcessRowRead, ProviderProcessRow } from './provider-process-row-read'
import type { ProviderControlCompletion } from './provider-control-completion'

const state = vi.hoisted<{ read: (pid: number) => ProcessRowRead }>(() => ({
  read: () => null
}))
vi.mock('./provider-process-row-read', async (importOriginal) => ({
  ...(await importOriginal<typeof RowReader>()),
  readPosixProcessRow: async (pid: number) => state.read(pid)
}))
vi.mock('./provider-group-orphan-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof GroupGuard>()),
  providerGroupAbsent: () => true,
  providerOwnershipAbsent: () => true,
  sweepOrphanedProviderGroup: async () => 'absent',
  retireProviderWatcher: async () => 'absent'
}))

const healthy = (pid: number): ProviderProcessRow => ({
  pid,
  ppid: pid === 900002 ? 900001 : process.pid,
  pgid: pid,
  startedAt: '1234',
  startResolution: 'clock-tick'
})

let root: string | undefined
afterEach(async () => {
  vi.resetModules()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

it.each<ProviderControlCompletion | undefined>(['group-absent', undefined])(
  'retains ownership after an unproven fault capture despite group absence (%s)',
  async (completion) => {
    root = await mkdtemp(join(tmpdir(), 'orca-provider-fault-retention-'))
    const directory = join(root, 'provider-processes')
    state.read = healthy
    const { publishProviderOwnership } = await import('./provider-ownership-journal')
    const { ProviderFaultOwnership } = await import('./provider-fault-ownership')
    const { reapDirectProviderGroup } = await import('./direct-provider-group-reap')
    const published = publishProviderOwnership(directory, 'test-boot', 900001, 900002)
    await published
    state.read = () => 'unverifiable'
    const fault = new ProviderFaultOwnership()
    fault.stopAfterCapture(published, () => {})
    // The reap starts while capture is still pending, as a late native frame would.
    await reapDirectProviderGroup(
      true,
      () => 900001,
      () => published,
      () => {},
      () => fault.descendantsCleaned(),
      completion
    )
    await fault.task
    expect(await readdir(directory)).toHaveLength(1)

    vi.resetModules()
    state.read = (pid) =>
      pid === process.pid ? { ...healthy(pid), startedAt: '5678' } : 'unverifiable'
    const fresh = await import('./provider-ownership-journal')
    await fresh.recoverProviderOwnership(directory, 'test-boot')
    expect(await readdir(directory)).toHaveLength(1)

    for (const leader of [
      { ...healthy(900001), pgid: 900003 },
      { ...healthy(900001), startedAt: '5678', startResolution: 'second' as const }
    ]) {
      vi.resetModules()
      state.read = (pid) => (pid === process.pid ? { ...healthy(pid), startedAt: '5678' } : leader)
      const retry = await import('./provider-ownership-journal')
      await retry.recoverProviderOwnership(directory, 'test-boot')
      expect(await readdir(directory)).toHaveLength(1)
    }

    vi.resetModules()
    state.read = (pid) => (pid === process.pid ? { ...healthy(pid), startedAt: '5678' } : null)
    const exhausted = await import('./provider-ownership-journal')
    await exhausted.recoverProviderOwnership(directory, 'test-boot')
    expect(await readdir(directory)).toEqual([])
  }
)
