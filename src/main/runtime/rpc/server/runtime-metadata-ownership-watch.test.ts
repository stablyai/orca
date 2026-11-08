import { mkdtempSync } from 'node:fs'

import type * as NodeFs from 'node:fs'

import type * as NodeFsPromises from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import '../../../../shared/runtime-bootstrap'
import type { RuntimeMetadata } from '../../../../shared/runtime-bootstrap'

import { clearRuntimeMetadata, readRuntimeMetadata, writeRuntimeMetadata } from './runtime-metadata'

import {
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
