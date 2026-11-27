import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearRuntimeRestartMarker,
  writeRuntimeRestartMarker
} from '../../../main/runtime/rpc/server/runtime-restart-marker-file'
import { getRuntimeRestartMarkerPath } from '../../../shared/remote-runtime/bootstrap/runtime-restart-marker'
import { readActiveRuntimeRestart, RuntimeRestartWait } from './runtime-restart-wait'

describe('runtime restart marker', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-restart-marker-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is seen while fresh, and an expired or cleared marker never costs a wait', async () => {
    await writeRuntimeRestartMarker(dir, 'update')
    const { writtenAt } = JSON.parse(await readFile(getRuntimeRestartMarkerPath(dir), 'utf8'))

    expect((await readActiveRuntimeRestart(dir, writtenAt + 1_000))?.reason).toBe('update')
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
})
