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
vi.mock('../install/orcad-remote-log-tail', () => ({
  withOrcadLogTail: vi.fn(
    async (_target: unknown, _slotDir: string, message: string) =>
      `${message}\nLast lines of orcad.log:\n# Fatal process out of memory`
  )
}))

import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { OrcadLaunchReadinessError } from '../../ssh/orcad-active-readiness'
import { OrcadWindowsLaunchFailedError } from '../install/orcad-remote-launch-windows'
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

/** Each restarted orcad reports how the run before it ended. */
function startsReporting(previousUnexpectedExit: unknown): void {
  vi.mocked(wakeStoppedManagedOrcad).mockImplementation(async (_slot, onStarting) => {
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

    expect(wakeStoppedManagedOrcad).toHaveBeenCalledTimes(3)
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
    expect(wakeStoppedManagedOrcad).toHaveBeenCalledTimes(4)
  })

  it('also stops after starts that die before becoming ready, counting each run once', async () => {
    vi.mocked(wakeStoppedManagedOrcad).mockImplementation(async (_slot, onStarting) => {
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
    expect(wakeStoppedManagedOrcad).toHaveBeenCalledTimes(4)
  })

  it('also stops after the Windows launcher reports failing to start it', async () => {
    vi.mocked(wakeStoppedManagedOrcad).mockRejectedValue(
      new OrcadWindowsLaunchFailedError('CreateProcess failed (code 5)')
    )
    for (let i = 0; i < 3; i++) {
      await findStopped()
    }

    expect(await findStopped()).toMatchObject({ state: 'unverifiable' })
    expect(wakeStoppedManagedOrcad).toHaveBeenCalledTimes(3)
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

    expect(wakeStoppedManagedOrcad).toHaveBeenCalledTimes(3)
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
