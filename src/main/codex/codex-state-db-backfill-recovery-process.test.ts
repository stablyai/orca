import { EventEmitter } from 'node:events'
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

    await stopCodexBackfillRecoveryProcess(asHandle(child), true)

    expect(child.stdin.end).toHaveBeenCalledOnce()
    // A direct SIGTERM would skip the stdin-end grace a Codex close gets.
    expect(child.kill).not.toHaveBeenCalled()
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
  })

  it('tears the tree down only once the supervisor has had its full stop time', async () => {
    vi.useFakeTimers()
    const child = fakeSupervisor(false)

    const stopped = stopCodexBackfillRecoveryProcess(asHandle(child), true)
    await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS - 1)
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(terminateProviderProcessTree).toHaveBeenCalledWith(child, {
      site: 'codex-state-db-backfill-recovery'
    })
    // The shared close then waits, bounded, for the forced root's exit.
    await vi.advanceTimersByTimeAsync(1_000)
    await stopped

    // The stop signals nothing itself: the stdin end asks, and only the teardown forces.
    expect(child.stdin.end).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
  })
})
