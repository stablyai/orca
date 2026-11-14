import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { superviseServeService, type SupervisedServeOptions } from './serve-supervised-service'
import { readServeSupervisorBrake } from './serve-supervisor-brake'

/** Virtual clock: timers fire in order as soon as the loop awaits them. */
function harness(overrides: Partial<SupervisedServeOptions> & { userDataPath: string }) {
  let clock = 1_000_000
  const options: SupervisedServeOptions = {
    executable: '/opt/orca/orca',
    force: false,
    runOnce: async () => 1,
    readInstallEvidence: async () => ({ kind: 'clear' }),
    buildIdentity: () => 'build-a',
    now: () => clock,
    random: () => 0.5,
    setTimer: (callback, ms) => {
      clock += ms
      queueMicrotask(callback)
      return () => undefined
    },
    onStopSignal: () => () => undefined,
    log: () => undefined,
    ...overrides
  }
  return {
    options
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

  it('persists give-up after repeated child failure and refuses another launch', async () => {
    const h = harness({ userDataPath })
    await expect(superviseServeService(h.options)).resolves.toBe(0)
    const record = readServeSupervisorBrake(userDataPath)
    expect(record?.gaveUp?.reason).toContain('exited with code 1')

    const again = harness({
      userDataPath,
      runOnce: async () => {
        return 1
      }
    })
    await expect(superviseServeService(again.options)).resolves.toBe(0)
  })
})
