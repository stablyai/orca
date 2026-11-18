import { mkdtemp, rm } from 'node:fs/promises'
import type * as GroupGuard from './provider-group-orphan-guard'
import type * as RowReader from './provider-process-row-read'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { publishProviderOwnership } from './provider-ownership-journal'
import type { ProviderProcessRowReader } from './provider-process-row-read'

// A restart burst on macOS made ps reads time out together (#42760); every launch must still prove ownership (#43707).
const state = vi.hoisted<{ read?: ProviderProcessRowReader }>(() => ({}))
vi.mock('./provider-process-row-read', async (importOriginal) => ({
  ...(await importOriginal<typeof RowReader>()),
  readPosixProcessRow: (pid: number) => state.read!(pid)
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

it('publishes a burst of 25 launches whose first reads are all unverifiable at once', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-provider-proof-burst-'))
  const directory = join(root, 'provider-processes')
  const launches = Array.from({ length: 25 }, (_, index) => ({
    leader: 910000 + index * 2,
    watcher: 910001 + index * 2
  }))
  const wrongParentLeader = launches[7].leader
  // Hold every first leader read until all 25 are in flight, as a restart burst does, then fail each once.
  const firstReads = new Set<number>()
  let releaseBurst: () => void = () => {}
  const burst = new Promise<void>((resolve) => {
    releaseBurst = resolve
  })
  state.read = async (pid) => {
    const launch = launches.find((entry) => entry.leader === pid)
    if (launch && !firstReads.has(pid)) {
      firstReads.add(pid)
      if (firstReads.size === launches.length) {
        releaseBurst()
      }
      await burst
      return 'unverifiable'
    }
    const watcherOf = launches.find((entry) => entry.watcher === pid)
    const ppid = watcherOf ? watcherOf.leader : pid === wrongParentLeader ? 1 : process.pid
    return { pid, ppid, pgid: pid, startedAt: '1234', startResolution: 'clock-tick' }
  }

  const results = await Promise.allSettled(
    launches.map(({ leader, watcher }) =>
      publishProviderOwnership(directory, 'test-boot', leader, watcher)
    )
  )

  expect(firstReads.size).toBe(25)
  const refused = results.flatMap((result, index) =>
    result.status === 'rejected' ? [{ index, message: String(result.reason) }] : []
  )
  expect(refused).toEqual([
    { index: 7, message: expect.stringContaining(`leader ppid 1 != ${process.pid}`) }
  ])
  for (const result of results) {
    if (result.status === 'fulfilled') {
      await result.value.remove()
    }
  }
})
