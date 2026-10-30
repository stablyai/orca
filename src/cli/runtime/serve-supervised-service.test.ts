import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getServeSuperviseValidationError,
  superviseServeService,
  SERVE_INSTALL_HOLD_POLL_MS,
  type SupervisedServeOptions
} from './serve-supervised-service'
import {
  readServeSupervisorBrake,
  recordSupervisedFailure,
  emptyServeSupervisorBrake,
  SERVE_SUPERVISOR_FAILURE_LIMIT,
  SERVE_SUPERVISOR_FAILURE_WINDOW_MS,
  SERVE_SUPERVISOR_BACKOFF_MAX_MS,
  SERVE_GAVE_UP_ADVICE,
  type ServeSupervisorBrake
} from './serve-supervisor-brake'
import type { ServeInstallEvidence } from './serve-install-hold'
import { resolveOrcadExitCode } from '../../main/orcad/orcad-exit-code'
import { OrcadInstanceLockError } from '../../main/orcad/orcad-data-root-privacy'

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

  it('starts over for a new build or with --force', async () => {
    const gaveUp: ServeSupervisorBrake = {
      ...emptyServeSupervisorBrake('build-a'),
      gaveUp: { at: 1, reason: 'old' }
    }
    let runs = 0
    const newBuild = harness({
      userDataPath,
      readBrake: () => gaveUp,
      writeBrake: () => undefined,
      buildIdentity: () => 'build-b',
      runOnce: async () => {
        runs++
        newBuild.stop()
        return 0
      }
    })
    await expect(superviseServeService(newBuild.options)).resolves.toBe(0)
    expect(runs).toBe(1)

    let cleared = false
    const forced = harness({
      userDataPath,
      force: true,
      readBrake: () => gaveUp,
      clearBrake: () => {
        cleared = true
      },
      runOnce: async () => {
        runs++
        forced.stop()
        return 0
      }
    })
    await expect(superviseServeService(forced.options)).resolves.toBe(0)
    expect(cleared).toBe(true)
    expect(runs).toBe(2)
  })

  it('keeps a give-up while the executable is missing mid-install', async () => {
    const gaveUp: ServeSupervisorBrake = {
      ...emptyServeSupervisorBrake('build-a'),
      gaveUp: { at: 1, reason: 'old' }
    }
    const identities = ['missing', 'build-a']
    const evidence: ServeInstallEvidence[] = [{ kind: 'hold', reason: 'bundle-missing' }]
    let runs = 0
    const h = harness({
      userDataPath,
      readBrake: () => gaveUp,
      buildIdentity: () => identities.shift() ?? 'build-a',
      readInstallEvidence: async () => evidence.shift() ?? { kind: 'clear' },
      runOnce: async () => (runs++, 0)
    })
    await expect(superviseServeService(h.options)).resolves.toBe(0)
    expect(runs).toBe(0)
    expect(h.logs.join('\n')).toContain('Not starting')
    expect(h.logs.join('\n')).toContain(SERVE_GAVE_UP_ADVICE)
  })

  it('never spawns while the installer holds the bundle, even when the check fails', async () => {
    const evidence: ServeInstallEvidence[] = [
      { kind: 'hold', reason: 'installer-running' },
      { kind: 'hold', reason: 'installer-unknown' },
      { kind: 'hold', reason: 'bundle-missing' },
      { kind: 'clear' }
    ]
    let runs = 0
    const h = harness({
      userDataPath,
      readInstallEvidence: async () => evidence.shift() ?? { kind: 'clear' },
      runOnce: async () => {
        runs++
        expect(evidence).toHaveLength(0)
        h.stop()
        return 0
      }
    })
    await superviseServeService(h.options)
    expect(runs).toBe(1)
    expect(h.sleeps).toEqual([
      SERVE_INSTALL_HOLD_POLL_MS,
      SERVE_INSTALL_HOLD_POLL_MS,
      SERVE_INSTALL_HOLD_POLL_MS
    ])
  })

  it('hands the restart to the service manager when the executable stays gone', async () => {
    let runs = 0
    const h = harness({
      userDataPath,
      readInstallEvidence: async () => ({ kind: 'hold', reason: 'bundle-missing' }),
      runOnce: async () => (runs++, 0)
    })
    await expect(superviseServeService(h.options)).resolves.toBe(1)
    expect(runs).toBe(0)
  })

  it('waits for a live peer without counting it as a failure', async () => {
    let runs = 0
    const h = harness({
      userDataPath,
      runOnce: async () => {
        runs++
        if (runs === 20) {
          h.stop()
        }
        return 3
      }
    })
    await expect(superviseServeService(h.options)).resolves.toBe(0)
    expect(runs).toBe(20)
    expect(readServeSupervisorBrake(userDataPath)).toBeNull()
    expect(Math.max(...h.sleeps)).toBe(60_000)
  })

  // #32177: a lock this machine cannot judge (a shared home) is a peer, not a fault to give up on.
  it('waits on a lock holder it cannot judge, without giving up', async () => {
    const holderUnverifiable = resolveOrcadExitCode(
      new OrcadInstanceLockError('orcad_instance_lock_holder_unverifiable', 'shared home')
    )
    let runs = 0
    const h = harness({
      userDataPath,
      runOnce: async () => {
        runs++
        if (runs === 10) {
          h.stop()
        }
        return holderUnverifiable
      }
    })
    await expect(superviseServeService(h.options)).resolves.toBe(0)
    expect(runs).toBe(10)
    expect(readServeSupervisorBrake(userDataPath)).toBeNull()
  })

  it('counts a thrown child failure and keeps supervising', async () => {
    let runs = 0
    const h = harness({
      userDataPath,
      runOnce: async () => {
        runs++
        if (runs === 1) {
          throw new Error('Orca serve exited via SIGKILL.')
        }
        h.stop()
        return 0
      }
    })
    await expect(superviseServeService(h.options)).resolves.toBe(0)
    expect(runs).toBe(2)
    expect(h.logs).toContain('[serve] Orca serve exited via SIGKILL; restarting in 1s.')
  })

  it('restarts from a replaced AppImage before starting a child, not after it', async () => {
    const order: string[] = []
    const h = harness({
      userDataPath,
      runOnce: async () => (order.push('spawn'), 0),
      appImageUpdate: {
        inspect: () => 'superseded',
        restart: async () => {
          order.push('restart')
          h.stop()
          return 'the service is stopping'
        }
      }
    })
    await expect(superviseServeService(h.options)).resolves.toBe(0)
    expect(order).toEqual(['restart'])
  })

  it('does not let a give-up on the old build block a replaced AppImage', async () => {
    let restarts = 0
    const h = harness({
      userDataPath,
      readBrake: () => ({
        ...emptyServeSupervisorBrake('build-a'),
        gaveUp: { at: 1, reason: 'crashed' }
      }),
      appImageUpdate: {
        inspect: () => 'superseded',
        restart: async () => {
          restarts++
          h.stop()
          return 'the service is stopping'
        }
      }
    })
    await expect(superviseServeService(h.options)).resolves.toBe(0)
    expect(restarts).toBe(1)
    expect(h.logs.join('\n')).not.toContain('Not starting')
  })

  it('keeps serving the running build when the restart fails, without retrying it', async () => {
    let runs = 0
    let restarts = 0
    const h = harness({
      userDataPath,
      runOnce: async () => {
        if (++runs === 2) {
          h.stop()
        }
        return 1
      },
      appImageUpdate: {
        inspect: () => 'superseded',
        restart: async () => (restarts++, 'the new AppImage could not be unpacked')
      }
    })
    await expect(superviseServeService(h.options)).resolves.toBe(0)
    expect(restarts).toBe(1)
    expect(runs).toBe(2)
    expect(h.logs).toContain(
      '[serve] Kept the running build: the new AppImage could not be unpacked.'
    )
  })

  it('waits for a half-copied AppImage instead of starting either build', async () => {
    const states = ['settling', 'settling', 'current'] as const
    let inspections = 0
    let runs = 0
    const h = harness({
      userDataPath,
      runOnce: async () => (runs++, h.stop(), 0),
      appImageUpdate: {
        inspect: () => states[Math.min(inspections++, states.length - 1)]!,
        restart: async () => 'unused'
      }
    })
    await expect(superviseServeService(h.options)).resolves.toBe(0)
    expect(h.sleeps).toEqual([SERVE_INSTALL_HOLD_POLL_MS, SERVE_INSTALL_HOLD_POLL_MS])
    expect(runs).toBe(1)
  })

  it('exits 0 on a stop signal during backoff without starting again', async () => {
    let runs = 0
    const h = harness({ userDataPath, runOnce: async () => (runs++, 1) })
    h.options.setTimer = () => {
      queueMicrotask(() => h.stop())
      return () => undefined
    }
    await expect(superviseServeService(h.options)).resolves.toBe(0)
    expect(runs).toBe(1)
  })

  it('refuses --supervise on Windows and with --recipe-json', () => {
    expect(
      getServeSuperviseValidationError({ supervise: true, recipeJson: false, platform: 'win32' })
    ).toContain('Windows')
    expect(
      getServeSuperviseValidationError({ supervise: true, recipeJson: true, platform: 'linux' })
    ).toContain('--recipe-json')
    expect(
      getServeSuperviseValidationError({ supervise: false, recipeJson: true, platform: 'win32' })
    ).toBeNull()
  })
})

describe('recordSupervisedFailure', () => {
  it('ages failures out of the window and caps the delay', () => {
    let record = emptyServeSupervisorBrake('b')
    let now = 0
    const delays: number[] = []
    for (let i = 0; i < 20; i++) {
      now += SERVE_SUPERVISOR_FAILURE_WINDOW_MS / 4
      const next = recordSupervisedFailure(record, { now, reason: 'x', random: () => 0.5 })
      expect(next.action.kind).toBe('restart')
      if (next.action.kind === 'restart') {
        delays.push(next.action.delayMs)
      }
      record = next.record
    }
    expect(Math.max(...delays)).toBeLessThanOrEqual(SERVE_SUPERVISOR_BACKOFF_MAX_MS)
    expect(record.failures.length).toBeLessThan(SERVE_SUPERVISOR_FAILURE_LIMIT)
  })
})
