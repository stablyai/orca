import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { clearRuntimeMetadata, readRuntimeMetadata, writeRuntimeMetadata } from './runtime-metadata'
import {
  shouldReclaimRuntimeMetadata,
  watchRuntimeMetadataOwnership,
  type RuntimeMetadataOwnershipWatch
} from './runtime-metadata-ownership-watch'

const OWNED_PID = 4242
const OWNED_RUNTIME_ID = 'rt_owner'
const FOREIGN_LIVE_PID = 5151
const FOREIGN_DEAD_PID = 5252

function record(overrides: Partial<RuntimeMetadata> = {}): RuntimeMetadata {
  return {
    runtimeId: OWNED_RUNTIME_ID,
    pid: OWNED_PID,
    transports: [{ kind: 'unix', endpoint: '/tmp/orca-owner.sock' }],
    authToken: 'secret',
    startedAt: 100,
    ...overrides
  }
}

const isProcessRunning = (pid: number): boolean => pid === OWNED_PID || pid === FOREIGN_LIVE_PID

describe('shouldReclaimRuntimeMetadata', () => {
  it('leaves the record alone while it still describes this runtime', () => {
    expect(
      shouldReclaimRuntimeMetadata(record(), OWNED_PID, OWNED_RUNTIME_ID, isProcessRunning)
    ).toBe(false)
  })

  it('reclaims a missing record', () => {
    expect(shouldReclaimRuntimeMetadata(null, OWNED_PID, OWNED_RUNTIME_ID, isProcessRunning)).toBe(
      true
    )
  })

  it('reclaims a record left behind by a dead runtime', () => {
    expect(
      shouldReclaimRuntimeMetadata(
        record({ pid: FOREIGN_DEAD_PID, runtimeId: 'rt_second_instance' }),
        OWNED_PID,
        OWNED_RUNTIME_ID,
        isProcessRunning
      )
    ).toBe(true)
  })

  it('yields to another live runtime so two instances cannot ping-pong the record', () => {
    expect(
      shouldReclaimRuntimeMetadata(
        record({ pid: FOREIGN_LIVE_PID, runtimeId: 'rt_second_instance' }),
        OWNED_PID,
        OWNED_RUNTIME_ID,
        isProcessRunning
      )
    ).toBe(false)
  })

  it('reclaims a foreign runtimeId stamped on this pid', () => {
    // Why: only this process can be this pid, so the record is a recycled-pid leftover.
    expect(
      shouldReclaimRuntimeMetadata(
        record({ runtimeId: 'rt_previous_process' }),
        OWNED_PID,
        OWNED_RUNTIME_ID,
        isProcessRunning
      )
    ).toBe(true)
  })
})

describe('watchRuntimeMetadataOwnership', () => {
  const watches: RuntimeMetadataOwnershipWatch[] = []
  const userDataPaths: string[] = []

  afterEach(() => {
    for (const watch of watches.splice(0)) {
      watch.stop()
    }
    for (const dir of userDataPaths.splice(0)) {
      clearRuntimeMetadata(dir)
    }
    vi.useRealTimers()
  })

  function armWatch(userDataPath: string, pollIntervalMs = 10): RuntimeMetadataOwnershipWatch {
    const watch = watchRuntimeMetadataOwnership({
      userDataPath,
      ownedPid: OWNED_PID,
      ownedRuntimeId: OWNED_RUNTIME_ID,
      pollIntervalMs,
      isProcessRunning,
      republish: () => writeRuntimeMetadata(userDataPath, record())
    })
    watches.push(watch)
    return watch
  }

  function makeUserDataPath(): string {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-ownership-'))
    userDataPaths.push(userDataPath)
    return userDataPath
  }

  it('republishes after a second instance clobbers the record and exits', () => {
    const userDataPath = makeUserDataPath()
    writeRuntimeMetadata(userDataPath, record())
    const watch = armWatch(userDataPath)

    writeRuntimeMetadata(
      userDataPath,
      record({ pid: FOREIGN_DEAD_PID, runtimeId: 'rt_second_instance' })
    )
    watch.check()

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({
      pid: OWNED_PID,
      runtimeId: OWNED_RUNTIME_ID
    })
  })

  it('republishes a record that was deleted underneath the runtime', () => {
    const userDataPath = makeUserDataPath()
    writeRuntimeMetadata(userDataPath, record())
    const watch = armWatch(userDataPath)

    clearRuntimeMetadata(userDataPath)
    watch.check()

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: OWNED_PID })
  })

  it('replaces an unreadable record', () => {
    const userDataPath = makeUserDataPath()
    const watch = armWatch(userDataPath)
    writeFileSync(getRuntimeMetadataPath(userDataPath), '{ truncated')

    watch.check()

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: OWNED_PID })
  })

  it('leaves a live sibling runtime in place', () => {
    const userDataPath = makeUserDataPath()
    const watch = armWatch(userDataPath)
    writeRuntimeMetadata(
      userDataPath,
      record({ pid: FOREIGN_LIVE_PID, runtimeId: 'rt_second_instance' })
    )

    watch.check()

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: FOREIGN_LIVE_PID })
  })

  it('reclaims on the poll interval without an explicit check', () => {
    vi.useFakeTimers()
    const userDataPath = makeUserDataPath()
    armWatch(userDataPath, 1_000)
    writeRuntimeMetadata(
      userDataPath,
      record({ pid: FOREIGN_DEAD_PID, runtimeId: 'rt_second_instance' })
    )

    vi.advanceTimersByTime(1_000)

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: OWNED_PID })
  })

  it('stops reclaiming once the watch is stopped', () => {
    vi.useFakeTimers()
    const userDataPath = makeUserDataPath()
    const watch = armWatch(userDataPath, 1_000)

    watch.stop()
    writeRuntimeMetadata(
      userDataPath,
      record({ pid: FOREIGN_DEAD_PID, runtimeId: 'rt_second_instance' })
    )
    vi.advanceTimersByTime(5_000)

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: FOREIGN_DEAD_PID })
  })

  it('keeps polling after a republish failure', () => {
    vi.useFakeTimers()
    const userDataPath = makeUserDataPath()
    const republish = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('disk full')
      })
      .mockImplementation(() => writeRuntimeMetadata(userDataPath, record()))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const watch = watchRuntimeMetadataOwnership({
      userDataPath,
      ownedPid: OWNED_PID,
      ownedRuntimeId: OWNED_RUNTIME_ID,
      pollIntervalMs: 1_000,
      isProcessRunning,
      republish
    })
    watches.push(watch)

    vi.advanceTimersByTime(2_000)

    expect(republish).toHaveBeenCalledTimes(2)
    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: OWNED_PID })
    consoleError.mockRestore()
  })
})
