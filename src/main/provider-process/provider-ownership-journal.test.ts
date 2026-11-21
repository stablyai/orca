import { mkdtemp, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type * as FsPromises from 'node:fs/promises'
import type * as GroupGuard from './provider-group-orphan-guard'
import type * as RowReader from './provider-process-row-read'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { publishProviderOwnership, recoverProviderOwnership } from './provider-ownership-journal'
import type { ProviderProcessRow, ProviderProcessRowReader } from './provider-process-row-read'

const state = vi.hoisted<{ failWrite: boolean; read?: ProviderProcessRowReader }>(() => ({
  failWrite: true
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args)
      if (args[1] !== 'wx' || !state.failWrite) {
        return file
      }
      return {
        close: () => file.close(),
        sync: () => file.sync(),
        writeFile: async () => {
          await file.writeFile('{')
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        }
      }
    }
  }
})
vi.mock('./provider-process-row-read', async (importOriginal) => ({
  ...(await importOriginal<typeof RowReader>()),
  readPosixProcessRow: async (pid: number, resolution?: ProviderProcessRow['startResolution']) =>
    state.read
      ? state.read(pid, resolution)
      : {
          pid,
          ppid: pid === 900002 ? 900001 : process.pid,
          pgid: pid,
          startedAt: '1234',
          startResolution: 'clock-tick'
        }
}))
vi.mock('./provider-group-orphan-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof GroupGuard>()),
  providerGroupAbsent: () => true,
  providerOwnershipAbsent: () => true,
  sweepOrphanedProviderGroup: async () => 'absent',
  retireProviderWatcher: async () => 'absent'
}))
vi.mock('./provider-fault-ownership', () => ({
  terminateProviderFaultDescendants: async () => 'exited'
}))

let root: string | undefined
afterEach(async () => {
  state.read = undefined
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

async function record(directory: string, owner: ProviderProcessRow): Promise<string> {
  const nonce = randomUUID()
  await writeFile(
    join(directory, `${nonce}.json`),
    JSON.stringify({
      version: 1,
      nonce,
      hostname: hostname(),
      statePath: directory,
      bootId: 'test-boot',
      owner,
      leader: { ...owner, pid: 900001, pgid: 900001 },
      watcher: { ...owner, pid: 900002, pgid: 900002 },
      pgid: 900001
    }),
    { mode: 0o600 }
  )
  return `${nonce}.json`
}

it('verifies each recorded owner precision independently during one recovery scan', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-owner-precision-'))
  const directory = join(root, 'provider-processes')
  await mkdir(directory, { mode: 0o700 })
  const owner: ProviderProcessRow = {
    pid: process.pid,
    ppid: process.ppid,
    pgid: process.pid,
    startedAt: '2023-11-14T22:13:20.000Z',
    startResolution: 'second'
  }
  await record(directory, owner)
  await record(directory, {
    ...owner,
    startedAt: 'microsecond:1700000000:123456',
    startResolution: 'microsecond'
  })
  state.read = async (_pid, resolution) =>
    resolution === 'second'
      ? { ...owner, startedAt: '2023-11-14T22:13:21.000Z' }
      : { ...owner, startedAt: 'microsecond:1700000001:123456', startResolution: 'microsecond' }
  await recoverProviderOwnership(directory, 'test-boot')
  expect(await readdir(directory)).toEqual([])
})

it('retains a live owner omitted by the reader while recovering an absent owner', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-owner-unreadable-'))
  const directory = join(root, 'provider-processes')
  await mkdir(directory, { mode: 0o700 })
  const owner: ProviderProcessRow = {
    pid: process.pid,
    ppid: process.ppid,
    pgid: process.pid,
    startedAt: 'microsecond:1700000000:123456',
    startResolution: 'microsecond'
  }
  const live = await record(directory, owner)
  await record(directory, { ...owner, pid: 9_999_999 })
  state.read = async () => null
  await recoverProviderOwnership(directory, 'test-boot')
  expect(await readdir(directory)).toEqual([live])
})

it('removes a partial unpublished record on each failed write and allows a later launch', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-publication-'))
  const directory = join(root, 'provider-processes')
  state.failWrite = true
  for (let attempt = 0; attempt < 10; attempt++) {
    await expect(
      publishProviderOwnership(directory, 'test-boot', 900001, 900002)
    ).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(await readdir(directory)).toEqual([])
  }
  state.failWrite = false
  const published = await publishProviderOwnership(directory, 'test-boot', 900001, 900002)
  expect(await readdir(directory)).toHaveLength(1)
  await published.remove()
  expect(await readdir(directory)).toEqual([])
})

it('retries unverifiable launch reads but still refuses a definite parent mismatch', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-proof-retry-'))
  const directory = join(root, 'provider-processes')
  state.failWrite = false
  const row = (pid: number, ppid: number): ProviderProcessRow => ({
    pid,
    ppid,
    pgid: pid,
    startedAt: '1234',
    startResolution: 'clock-tick'
  })
  let failedLeaderReads = 0
  state.read = async (pid) => {
    if (pid === 900001 && failedLeaderReads < 2) {
      failedLeaderReads++
      return 'unverifiable'
    }
    return row(pid, pid === 900002 ? 900001 : process.pid)
  }
  const published = await publishProviderOwnership(directory, 'test-boot', 900001, 900002)
  expect(published.identity.leader).toEqual(row(900001, process.pid))
  await published.remove()

  state.read = async (pid) => row(pid, pid === 900002 ? 900001 : 1)
  await expect(publishProviderOwnership(directory, 'test-boot', 900001, 900002)).rejects.toThrow(
    `leader ppid 1 != ${process.pid}`
  )
})
