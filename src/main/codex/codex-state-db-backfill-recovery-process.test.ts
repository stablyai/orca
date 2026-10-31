import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { guardSupervisedProviderGroup } from '../provider-process/provider-group-orphan-guard'
import { createProviderLaunchReport } from '../provider-process/provider-launch-report'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { killSourceControlAgentProcess } from '../text-generation/source-control-agent-termination'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'
import { stopCodexBackfillRecoveryProcess } from './codex-state-db-backfill-recovery-process'

vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: vi.fn(async () => 'exited' as const)
}))

type FakeSupervisor = EventEmitter & {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdin: { end: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>
}

function fakeSupervisor(exitsOnStdinEnd: boolean): FakeSupervisor {
  const child: FakeSupervisor = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    stdin: {
      end: vi.fn(() => {
        if (exitsOnStdinEnd) {
          child.exitCode = 0
          child.emit('exit', 0, null)
        }
      })
    },
    kill: vi.fn(() => true)
  })
  return child
}

function asHandle(child: FakeSupervisor): ChildProcessHandle {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stop reads only pid, exit state, stdin, kill and the exit event, which the fake implements.
  return child as unknown as ChildProcessHandle
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('stopCodexBackfillRecoveryProcess for a supervised app-server', () => {
  it('ends its input and leaves the group stop to the supervisor', async () => {
    const child = fakeSupervisor(true)

    await stopCodexBackfillRecoveryProcess({
      child: asHandle(child),
      supervised: true,
      launchReport: createProviderLaunchReport(child, false)
    })

    expect(child.stdin.end).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
  })

  it('tears the tree down only once the supervisor has had its full stop time', async () => {
    vi.useFakeTimers()
    const child = fakeSupervisor(false)

    const stopped = expect(
      stopCodexBackfillRecoveryProcess({
        child: asHandle(child),
        supervised: true,
        launchReport: createProviderLaunchReport(child, false)
      })
    ).rejects.toThrow('termination was not confirmed')
    await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS - 1)
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(terminateProviderProcessTree).toHaveBeenCalledWith(child, {
      site: 'codex-state-db-backfill-recovery',
      supervised: true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await stopped

    expect(child.stdin.end).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
  })
})

it.each(['backfill', 'generation'] as const)(
  '%s retains a partial report after refusal and retires the same owner on accepted no-root retry',
  async (caller) => {
    vi.useFakeTimers()
    const child = createFakePipedChild(424242)
    const incoming = new PassThrough(),
      outgoing = new PassThrough()
    outgoing.resume()
    const channel = Duplex.from({ readable: incoming, writable: outgoing })
    child.stdio[3] = channel
    const launchReport = createProviderLaunchReport(child, true)
    expect(
      guardSupervisedProviderGroup(child, {
        site: 'stop-report-test',
        supervised: true,
        report: launchReport
      })
    ).toBe(true)
    const owned = Object.assign(child, { supervised: true, launchReport })
    const stop = () =>
      caller === 'backfill'
        ? stopCodexBackfillRecoveryProcess({ child, supervised: true, launchReport })
        : killSourceControlAgentProcess(owned)
    try {
      incoming.write('{"kind":"spawned","pgid":')
      vi.mocked(terminateProviderProcessTree).mockResolvedValueOnce('unverifiable')
      const refused = expect(stop()).rejects.toThrow('termination was not confirmed')
      await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS + 1_000)
      await refused
      expect(channel.destroyed).toBe(false)
      expect(child.listenerCount('exit')).toBe(2)
      vi.mocked(terminateProviderProcessTree).mockResolvedValueOnce({
        tree: 'unverifiable',
        killDelivered: true
      })
      const accepted = stop()
      await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS + 1_000)
      await accepted
      await launchReport.closed
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
      expect(channel.destroyed).toBe(true)
      expect(child.listenerCount('exit')).toBe(1)
      expect(launchReport.record).toBeNull()
      expect(terminateProviderProcessTree).toHaveBeenCalledTimes(2)
      expect(child.stdin.writableEnded).toBe(true)
    } finally {
      launchReport.retire()
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      incoming.destroy()
      outgoing.destroy()
      channel.destroy()
      await launchReport.closed
    }
  }
)
