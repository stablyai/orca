import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearRuntimeRestartMarker,
  writeRuntimeRestartMarker
} from '../../../main/runtime/rpc/server/runtime-restart-marker-file'
import {
  getRuntimeRestartMarkerPath,
  type RuntimeRestartMarker
} from '../../../shared/remote-runtime/bootstrap/runtime-restart-marker'
import { readActiveRuntimeRestart, RuntimeRestartWait } from './runtime-restart-wait'
import { runtimeRestartingError } from './runtime-restarting-error'

describe('runtime restart marker', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-restart-marker-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is seen while fresh, and an expired or cleared marker never costs a wait', async () => {
    // A Windows update skips the wait by design, so the wait case uses a relaunch.
    await writeRuntimeRestartMarker(dir, 'relaunch')
    const { writtenAt } = JSON.parse(await readFile(getRuntimeRestartMarkerPath(dir), 'utf8'))

    expect((await readActiveRuntimeRestart(dir, writtenAt + 1_000))?.reason).toBe('relaunch')
    expect(await readActiveRuntimeRestart(dir, writtenAt + 90_000)).toBeNull()

    const sleeps: number[] = []
    const sleep = async (ms: number) => {
      sleeps.push(ms)
    }
    const expired = new RuntimeRestartWait(dir, { now: () => writtenAt + 90_000, sleep })
    expect(await expired.shouldRetry()).toBe(false)

    const fresh = new RuntimeRestartWait(dir, { now: () => writtenAt + 1_000, sleep })
    expect(await fresh.shouldRetry()).toBe(true)

    await clearRuntimeRestartMarker(dir)
    expect(await fresh.shouldRetry()).toBe(false)
    expect(sleeps).toEqual([1_000])
  })

  it('a relaunch that never comes back reads restarting, then may be down, then not running', async () => {
    const writtenAt = 1_800_000_000_000
    // The quitting app is gone, as after a relaunch that failed to start.
    const marker: RuntimeRestartMarker = { reason: 'relaunch', writtenAt, pid: 2_000_000_000 }
    await writeFile(getRuntimeRestartMarkerPath(dir), JSON.stringify(marker))
    let now = writtenAt + 30_000
    const sleeps: number[] = []
    const wait = new RuntimeRestartWait(dir, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      }
    })

    // Fresh: it waits, but only until the restart turns overdue (15 s), not a full 30 s.
    expect(runtimeRestartingError(marker, now).message).toMatch(/^Orca is restarting/)
    while (await wait.shouldRetry()) {
      // keep polling
    }
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(15_000)
    expect(wait.restart).toEqual(marker)
    const overdue = runtimeRestartingError(marker, now)
    expect(overdue.message).toMatch(/hasn't come back, so it may be down/)
    expect(JSON.stringify(overdue.data)).not.toMatch(/Don't run/)

    // Overdue: a new command fails at once.
    const later = new RuntimeRestartWait(dir, { now: () => now, sleep: async () => expect.fail() })
    expect(await later.shouldRetry()).toBe(false)

    // Expired: no restart at all, so the CLI reports Orca not running.
    expect(await readActiveRuntimeRestart(dir, writtenAt + 90_000)).toBeNull()
  })
})
