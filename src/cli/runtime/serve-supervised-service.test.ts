import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { superviseServeService, type SupervisedServeOptions } from './serve-supervised-service'
import { readServeSupervisorBrake, SERVE_SUPERVISOR_FAILURE_LIMIT } from './serve-supervisor-brake'

/** Virtual clock: timers fire in order as soon as the loop awaits them. */
function harness(overrides: Partial<SupervisedServeOptions> & { userDataPath: string }) {
  let clock = 1_000_000
  const sleeps: number[] = []
  const logs: string[] = []
  let stopListener: (() => void) | null = null
  const options: SupervisedServeOptions = {
    executable: '/opt/orca/orca',
    force: false,
    runOnce: async () => 1,
    readInstallEvidence: async () => ({ kind: 'clear' }),
    buildIdentity: () => 'build-a',
    now: () => clock,
    random: () => 0.5,
    setTimer: (callback, ms) => {
      sleeps.push(ms)
      clock += ms
      queueMicrotask(callback)
      return () => undefined
    },
    onStopSignal: (listener) => {
      stopListener = listener
      return () => {
        stopListener = null
      }
    },
    log: (line) => logs.push(line),
    ...overrides
  }
  return {
    options,
    sleeps,
    logs,
    stop: () => stopListener?.(),
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('superviseServeService', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'orca-supervise-'))
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('restarts a dying child with growing delays, then gives up and exits 0 durably', async () => {
    let runs = 0
    const h = harness({
      userDataPath,
      runOnce: async () => {
        runs++
        return 1
      }
    })
    await expect(superviseServeService(h.options)).resolves.toBe(0)
    expect(runs).toBe(SERVE_SUPERVISOR_FAILURE_LIMIT)
    expect(h.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    const record = readServeSupervisorBrake(userDataPath)
    expect(record?.gaveUp?.reason).toContain('exited with code 1')

    let rerun = 0
    const again = harness({
      userDataPath,
      runOnce: async () => {
        rerun++
        return 1
      }
    })
    await expect(superviseServeService(again.options)).resolves.toBe(0)
    expect(rerun).toBe(0)
    expect(again.logs.join('\n')).toContain('--force')
  })

  // #32177: a lock this machine cannot judge (a shared home) is a peer, not a fault to give up on.
})
