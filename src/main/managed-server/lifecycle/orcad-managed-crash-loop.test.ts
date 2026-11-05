import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

vi.mock('../install/orcad-remote-context', () => ({
  resolveOrcadRemoteContext: vi.fn(async () => ({
    connection: {},
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/u',
    userDataDir: '/home/u/.orca'
  }))
}))
vi.mock('./orcad-managed-wake', () => ({ wakeStoppedManagedOrcad: vi.fn() }))
vi.mock('../activation/orcad-activation-record-store', () => ({
  readOrcadActivationRecord: vi.fn(async () => ({ active: 'orcad-1.2.3' }))
}))
vi.mock('../../ssh/orcad-recovery-slot', () => ({
  orcadSlotDir: (_slot: unknown, version: string) => `/home/u/.orca-remote/${version}`
}))
vi.mock('../install/orcad-remote-record-file', () => ({
  // The latched run's lock: left behind when it died, removed when it stopped cleanly.
  readBoundedOrcadRemoteRecord: vi.fn(async () => ({ state: 'present', raw: '{}' }))
}))
vi.mock('../install/orcad-remote-runtime-control', () => ({
  // The answering machine's boot id, hostname and machine id.
  execOrcadRemote: vi.fn(async () => 'boot-a\nnode-1\nmachine-1\n')
}))
vi.mock('../install/orcad-remote-log-tail', () => ({
  withOrcadLogTail: vi.fn(
    async (_target: unknown, _slotDir: string, message: string) =>
      `${message}\nLast lines of orcad.log:\n# Fatal process out of memory`
  )
}))

import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { readBoundedOrcadRemoteRecord } from '../install/orcad-remote-record-file'
import { execOrcadRemote } from '../install/orcad-remote-runtime-control'
import { OrcadLaunchReadinessError } from '../../ssh/orcad-active-readiness'
import {
  OrcadWindowsLaunchFailedError,
  OrcadWindowsLaunchRefusedError
} from '../install/orcad-remote-launch-windows'
import {
  ensureManagedOrcadServing,
  setManagedOrcadStartListener,
  type OrcadManagedServingInput
} from './orcad-managed-serving'
import { getManagedOrcadCrashLoopBrake } from './orcad-managed-crash-loop'
import { forgetManagedOrcadAutomaticFailures } from './orcad-managed-tunnel'

const listener = { starting: vi.fn(), settled: vi.fn() }
let generation = 1
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the transport generation is read; the remote context is mocked.
const connection = { getConnectGeneration: () => generation } as never

function input(): OrcadManagedServingInput {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the id is read.
    environment: { id: 'env-1' } as never,
    target: { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' },
    connection,
    remotePort: 6768,
    probe: vi.fn(async () => false)
  }
}

type Wake = Awaited<ReturnType<typeof wakeStoppedManagedOrcad>>

/** A stopped slot: the wake consults the launch gate, then launches as `launch` does. */
let launches = 0
function stoppedSlotLaunches(launch: (onStarting?: () => void) => Promise<Wake>): void {
  vi.mocked(wakeStoppedManagedOrcad).mockImplementation(async (_slot, onStarting, mayLaunch) => {
    if (mayLaunch && !mayLaunch()) {
      return { outcome: 'launch-refused' }
    }
    launches += 1
    return launch(onStarting)
  })
}

/** Each restarted orcad reports how the run before it ended. */
function startsReporting(previousUnexpectedExit: unknown): void {
  stoppedSlotLaunches(async (onStarting) => {
    onStarting?.()
    const health = { previousIdleStop: null, previousUnexpectedExit }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only health is read.
    return { outcome: 'started', readiness: { health } as never }
  })
}

// A fresh transport each time, as a reconnect after each crash would give.
async function findStopped() {
  generation += 1
  return ensureManagedOrcadServing(input())
}

const CRASHED = { pid: 4242, version: '1.2.3', acquiredAt: '2026-11-04T10:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  launches = 0
  vi.mocked(execOrcadRemote).mockResolvedValue('boot-a\nnode-1\nmachine-1\n')
  getManagedOrcadCrashLoopBrake().forget('env-1')
  setManagedOrcadStartListener(listener)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a managed orcad that keeps exiting unexpectedly', () => {
  it('stops restarting it after three unexpected exits and shows why and how to recover', async () => {
    startsReporting(CRASHED)
    for (let i = 0; i < 3; i++) {
      expect(await findStopped()).toMatchObject({ state: 'started' })
    }

    const serving = await findStopped()

    expect(launches).toBe(3)
    expect(serving).toEqual({
      state: 'unverifiable',
      detail: expect.stringContaining(
        'Check /home/u/.orca-remote/orcad-1.2.3/orcad.log on the host, fix the cause, then disconnect and reconnect the host to try again.\nLast lines of orcad.log:\n# Fatal process out of memory'
      )
    })
    expect(listener.settled).toHaveBeenLastCalledWith(expect.anything(), 'env-1', serving)
  })

  it('keeps restarting a server whose earlier runs stopped cleanly or predate the report', async () => {
    for (const report of [null, undefined, null, undefined]) {
      startsReporting(report)
      expect(await findStopped()).toMatchObject({ state: 'started' })
    }
    expect(launches).toBe(4)
  })

  it('also stops after starts that die before becoming ready, counting each run once', async () => {
    stoppedSlotLaunches(async (onStarting) => {
      onStarting?.()
      throw new OrcadLaunchReadinessError('rejected', 'orcad did not become ready')
    })
    await findStopped()
    // The next orcad reports the run that just failed to start; it is already counted.
    startsReporting(CRASHED)
    await findStopped()
    await findStopped()
    expect(await findStopped()).toMatchObject({ state: 'started' })

    expect(await findStopped()).toMatchObject({ state: 'unverifiable' })
    expect(launches).toBe(4)
  })

  it('also stops after the Windows launcher reports failing to start it, and says how', async () => {
    stoppedSlotLaunches(async () => {
      throw new OrcadWindowsLaunchFailedError('CreateProcess failed (code 5)')
    })
    for (let i = 0; i < 3; i++) {
      await findStopped()
    }

    expect(await findStopped()).toMatchObject({
      state: 'unverifiable',
      detail: expect.stringContaining(
        "Last failed start: orcad's Windows launcher did not start the candidate: CreateProcess failed (code 5)."
      )
    })
    expect(launches).toBe(3)
  })

  it.each(['fenced', 'recovery-refused'] as const)(
    'counts starts that fail while recovering an interrupted activation (%s)',
    async (outcome) => {
      stoppedSlotLaunches(async () => ({
        outcome,
        reason: 'The host remains fenced.',
        launchFailure: new OrcadLaunchReadinessError('rejected', 'orcad did not become ready')
      }))
      for (let i = 0; i < 3; i++) {
        await findStopped()
      }

      expect(await findStopped()).toMatchObject({
        detail: expect.stringContaining('Orca stopped restarting its server on Box')
      })
      expect(launches).toBe(3)
    }
  )

  // A Windows launch failure ran nothing, so the next report names an earlier run.
  it('still counts the crash the next orcad reports after a Windows launch failure', async () => {
    stoppedSlotLaunches(async () => {
      throw new OrcadWindowsLaunchFailedError('CreateProcess failed (code 5)')
    })
    await findStopped()
    startsReporting(CRASHED)
    await findStopped()
    await findStopped()

    expect(await findStopped()).toMatchObject({ state: 'unverifiable' })
    expect(launches).toBe(3)
  })

  // Nothing ran, and the refusal's own message says what to change on the host.
  it('keeps showing a Windows host-policy refusal instead of braking on it', async () => {
    const refusal = new OrcadWindowsLaunchRefusedError('breakaway-denied')
    stoppedSlotLaunches(async () => {
      throw refusal
    })
    for (let i = 0; i < 4; i++) {
      expect(await findStopped()).toEqual({ state: 'unverifiable', detail: refusal.message })
    }
  })

  it('still reports a braked host whose server is running as it is', async () => {
    startsReporting(CRASHED)
    for (let i = 0; i < 3; i++) {
      await findStopped()
    }
    // A live slot never reaches the launch decision.
    vi.mocked(wakeStoppedManagedOrcad).mockResolvedValueOnce({ outcome: 'serving' })

    expect(await findStopped()).toEqual({
      state: 'unverifiable',
      detail: 'This host’s Orca server process is live but is not answering.'
    })
  })

  it.each([
    ['crashed after serving', () => startsReporting(CRASHED)],
    [
      'never became ready',
      () =>
        stoppedSlotLaunches(async () => {
          throw new OrcadLaunchReadinessError('rejected', 'orcad did not become ready')
        })
    ]
  ])(
    'wakes it again once the same machine rebooted after runs that %s',
    async (_case, failEachRun) => {
      failEachRun()
      for (let i = 0; i < 3; i++) {
        await findStopped()
      }
      startsReporting(null)

      expect(await findStopped()).toMatchObject({ state: 'unverifiable' })
      vi.mocked(execOrcadRemote).mockResolvedValueOnce('boot-b\nnode-1\nmachine-1\n')
      expect(await findStopped()).toMatchObject({ state: 'started' })
    }
  )

  // A lock from before the loop (or from another machine) says nothing about this machine's boot.
  it('stays braked when only the leftover lock comes from another boot', async () => {
    stoppedSlotLaunches(async () => {
      throw new OrcadLaunchReadinessError('rejected', 'orcad did not become ready')
    })
    for (let i = 0; i < 3; i++) {
      await findStopped()
    }
    const oldBootLock = JSON.stringify({
      pid: 4343,
      startedAtMs: 1,
      bootId: 'boot-old',
      identity: '1000',
      version: '1.2.3',
      acquiredAt: '2026-11-03T10:05:00.000Z',
      nonce: 'n'
    })
    vi.mocked(readBoundedOrcadRemoteRecord).mockResolvedValueOnce({
      state: 'present',
      raw: oldBootLock
    })

    expect(await findStopped()).toMatchObject({ state: 'unverifiable' })
    expect(launches).toBe(3)
  })

  it('stays braked without a machine id to tell this machine apart', async () => {
    vi.mocked(execOrcadRemote).mockResolvedValue('boot-a\nnode-1\n')
    startsReporting(CRASHED)
    for (let i = 0; i < 3; i++) {
      await findStopped()
    }
    vi.mocked(execOrcadRemote).mockResolvedValue('boot-b\nnode-1\n')

    expect(await findStopped()).toMatchObject({ state: 'unverifiable' })
  })

  // Shared homes: login nodes behind one hostname may answer, each with its own boot.
  it('stays braked when a different machine answers', async () => {
    startsReporting(CRASHED)
    for (let i = 0; i < 3; i++) {
      await findStopped()
    }
    vi.mocked(execOrcadRemote).mockResolvedValueOnce('boot-b\nnode-1\nmachine-2\n')

    expect(await findStopped()).toMatchObject({ state: 'unverifiable' })
    expect(launches).toBe(3)
  })

  it('wakes it again once a start that timed out later served and then stopped cleanly', async () => {
    stoppedSlotLaunches(async () => {
      throw new OrcadLaunchReadinessError('rejected', 'orcad did not become ready')
    })
    for (let i = 0; i < 3; i++) {
      await findStopped()
    }
    // The last of them came up after all.
    generation += 1
    expect(await ensureManagedOrcadServing({ ...input(), probe: async () => true })).toEqual({
      state: 'serving'
    })
    startsReporting(null)
    vi.mocked(readBoundedOrcadRemoteRecord).mockResolvedValueOnce({ state: 'absent' })

    expect(await findStopped()).toMatchObject({ state: 'started' })
  })

  it('wakes it again once the run it braked on later stopped cleanly', async () => {
    startsReporting(CRASHED)
    for (let i = 0; i < 3; i++) {
      await findStopped()
    }
    vi.mocked(readBoundedOrcadRemoteRecord).mockResolvedValueOnce({ state: 'absent' })

    expect(await findStopped()).toMatchObject({ state: 'started' })
  })

  it('does not let overlapping checks launch past the cap', async () => {
    startsReporting(CRASHED)
    await findStopped()
    await findStopped()

    generation += 1
    const first = ensureManagedOrcadServing(input())
    generation += 1
    const second = ensureManagedOrcadServing(input())
    await Promise.all([first, second])

    expect(launches).toBe(3)
  })

  it('does not let a start begun before a reconnect count against it', async () => {
    let finish = (): void => {}
    vi.mocked(wakeStoppedManagedOrcad).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (finish = resolve))
      const health = { previousUnexpectedExit: CRASHED }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only health is read.
      return { outcome: 'started', readiness: { health } as never }
    })
    const pending = findStopped()
    await vi.waitFor(() => expect(wakeStoppedManagedOrcad).toHaveBeenCalledOnce())
    forgetManagedOrcadAutomaticFailures('/unused-user-data', 'env-1')
    finish()
    await pending

    startsReporting(CRASHED)
    await findStopped()
    await findStopped()
    expect(await findStopped()).toMatchObject({ state: 'started' })
  })

  it('restarts it again once the user reconnects', async () => {
    startsReporting(CRASHED)
    for (let i = 0; i < 3; i++) {
      await findStopped()
    }
    expect(await findStopped()).toMatchObject({ state: 'unverifiable' })

    // What an explicit Connect on the host runs.
    forgetManagedOrcadAutomaticFailures('/unused-user-data', 'env-1')

    expect(await findStopped()).toMatchObject({ state: 'started' })
  })
})
