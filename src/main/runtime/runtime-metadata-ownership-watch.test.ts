import { mkdtempSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
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

// Counts blocking fs calls against orca-runtime.json so the poll tick's I/O stays off the main thread.
const metadataSyncCalls = vi.hoisted(() => {
  const state = { recording: false, calls: [] as string[] }
  return {
    state,
    record(fn: string, target: unknown): void {
      if (state.recording && typeof target === 'string' && target.endsWith('orca-runtime.json')) {
        state.calls.push(fn)
      }
    }
  }
})

// Lets a test park the tick's async read so overlapping ticks are observable without wall clocks.
const metadataReadGate = vi.hoisted(() => {
  const gate = {
    hold: false,
    reads: 0,
    parked: [] as (() => void)[],
    /** Reads handed to the real fs; parked ones are excluded so `whenIdle` stays answerable. */
    active: 0,
    idle: [] as (() => void)[],
    whenIdle(): Promise<void> {
      return gate.active === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => gate.idle.push(resolve))
    }
  }
  return gate
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    default: actual,
    readFile: (async (target: unknown, options: never) => {
      const call = (): unknown =>
        (actual.readFile as (...args: never[]) => unknown)(target as never, options)
      if (typeof target !== 'string' || !target.endsWith('orca-runtime.json')) {
        return call()
      }
      metadataReadGate.reads += 1
      if (metadataReadGate.hold) {
        await new Promise<void>((resolve) => metadataReadGate.parked.push(resolve))
      }
      metadataReadGate.active += 1
      try {
        return await call()
      } finally {
        metadataReadGate.active -= 1
        if (metadataReadGate.active === 0) {
          for (const resolve of metadataReadGate.idle.splice(0)) {
            resolve()
          }
        }
      }
    }) as typeof actual.readFile
  }
})

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    existsSync: (target: NodeFs.PathLike) => {
      metadataSyncCalls.record('existsSync', target)
      return actual.existsSync(target)
    },
    readFileSync: ((target: never, options: never) => {
      metadataSyncCalls.record('readFileSync', target)
      return actual.readFileSync(target, options)
    }) as typeof actual.readFileSync
  }
})

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
    metadataSyncCalls.state.recording = false
    metadataSyncCalls.state.calls.length = 0
    metadataReadGate.hold = false
    metadataReadGate.reads = 0
    for (const resume of metadataReadGate.parked.splice(0)) {
      resume()
    }
    metadataReadGate.idle.splice(0)
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

  function usePolledTimers(): void {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  }

  /** Waits out the tick's real read; everything after it resolves as microtasks. */
  async function settleReads(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve))
    await metadataReadGate.whenIdle()
    await new Promise((resolve) => setImmediate(resolve))
  }

  /** Fires one interval at a time so each tick's async read settles before the next. */
  async function advancePolls(ms: number, stepMs = 1_000): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
      await vi.advanceTimersByTimeAsync(stepMs)
      await settleReads()
    }
  }

  function makeUserDataPath(): string {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-ownership-'))
    userDataPaths.push(userDataPath)
    return userDataPath
  }

  it('republishes after a second instance clobbers the record and exits', async () => {
    const userDataPath = makeUserDataPath()
    writeRuntimeMetadata(userDataPath, record())
    const watch = armWatch(userDataPath)

    writeRuntimeMetadata(
      userDataPath,
      record({ pid: FOREIGN_DEAD_PID, runtimeId: 'rt_second_instance' })
    )
    await watch.check()

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({
      pid: OWNED_PID,
      runtimeId: OWNED_RUNTIME_ID
    })
  })

  it('republishes a record that was deleted underneath the runtime', async () => {
    const userDataPath = makeUserDataPath()
    writeRuntimeMetadata(userDataPath, record())
    const watch = armWatch(userDataPath)

    clearRuntimeMetadata(userDataPath)
    await watch.check()

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: OWNED_PID })
  })

  it('replaces an unreadable record', async () => {
    const userDataPath = makeUserDataPath()
    const watch = armWatch(userDataPath)
    writeFileSync(getRuntimeMetadataPath(userDataPath), '{ truncated')

    await watch.check()

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: OWNED_PID })
  })

  it('leaves a live sibling runtime in place', async () => {
    const userDataPath = makeUserDataPath()
    const watch = armWatch(userDataPath)
    writeRuntimeMetadata(
      userDataPath,
      record({ pid: FOREIGN_LIVE_PID, runtimeId: 'rt_second_instance' })
    )

    await watch.check()

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: FOREIGN_LIVE_PID })
  })

  it('reclaims on the poll interval without an explicit check', async () => {
    usePolledTimers()
    const userDataPath = makeUserDataPath()
    armWatch(userDataPath, 1_000)
    writeRuntimeMetadata(
      userDataPath,
      record({ pid: FOREIGN_DEAD_PID, runtimeId: 'rt_second_instance' })
    )

    await advancePolls(1_000)

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: OWNED_PID })
  })

  it('stops reclaiming once the watch is stopped', async () => {
    usePolledTimers()
    const userDataPath = makeUserDataPath()
    const watch = armWatch(userDataPath, 1_000)

    watch.stop()
    writeRuntimeMetadata(
      userDataPath,
      record({ pid: FOREIGN_DEAD_PID, runtimeId: 'rt_second_instance' })
    )
    await advancePolls(5_000)

    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: FOREIGN_DEAD_PID })
  })

  it('reads the record off-thread, so the poll tick never blocks the main thread', async () => {
    const userDataPath = makeUserDataPath()
    writeRuntimeMetadata(userDataPath, record())
    const watch = armWatch(userDataPath)

    metadataSyncCalls.state.recording = true
    await watch.check()
    await watch.check()
    metadataSyncCalls.state.recording = false

    expect(metadataSyncCalls.state.calls).toEqual([])
  })

  it('treats a missing record as reclaimable without a pre-existence check', async () => {
    const userDataPath = makeUserDataPath()
    const watch = armWatch(userDataPath)

    metadataSyncCalls.state.recording = true
    await watch.check()
    metadataSyncCalls.state.recording = false

    expect(metadataSyncCalls.state.calls).toEqual([])
    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: OWNED_PID })
  })

  it('never runs two overlapping ownership checks', async () => {
    usePolledTimers()
    const userDataPath = makeUserDataPath()
    writeRuntimeMetadata(userDataPath, record())
    armWatch(userDataPath, 1_000)

    metadataReadGate.hold = true
    await advancePolls(3_000)

    expect(metadataReadGate.reads).toBe(1)

    metadataReadGate.hold = false
    for (const resume of metadataReadGate.parked.splice(0)) {
      resume()
    }
    await settleReads()
    await advancePolls(1_000)

    expect(metadataReadGate.reads).toBe(2)
  })

  it('keeps polling after a republish failure', async () => {
    usePolledTimers()
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

    await advancePolls(2_000)

    expect(republish).toHaveBeenCalledTimes(2)
    expect(readRuntimeMetadata(userDataPath)).toMatchObject({ pid: OWNED_PID })
    consoleError.mockRestore()
  })
})
