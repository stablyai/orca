// The daemon's synchronous foreground read cannot tell node-pty's silent
// shell-title fallback from a real idle shell on its own, so a shell-shaped
// title is only an observation while a completed scan corroborates it. Pins
// how each scan outcome settles (docs/reference/ssh-execution-boundary.md).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'

const resolveAgentForegroundProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'
import { buildDaemonInspectProcessResult } from './terminal-host-process-evidence'
import type { ForegroundProcessObservation, SubprocessHandle } from './session-subprocess-handle'

const SHELL_PID = 999_999_517
// Above the idle-shell refresh throttle (5s) so each read starts a fresh scan.
const PAST_THE_SCAN_THROTTLE_MS = 6_000
// Bracket the 30s shell-title corroboration window from both sides.
const INSIDE_CORROBORATION_WINDOW_MS = 25_000
const PAST_CORROBORATION_WINDOW_MS = 35_000

describe('daemon foreground observation evidence', () => {
  let platformDescriptor: PropertyDescriptor | undefined
  let nodePty: pty.IPty & { process: string }
  let handle: SubprocessHandle
  let exitListeners: ((event: { exitCode: number; signal?: number }) => void)[]

  function observe(): ForegroundProcessObservation {
    const observation = handle.observeForegroundProcess?.()
    if (!observation) {
      throw new Error('handle exposes no foreground evidence channel')
    }
    return observation
  }

  /** The children verdict the completion monitor actually acts on. */
  function childrenVerdict(observation: ForegroundProcessObservation): string | undefined {
    return buildDaemonInspectProcessResult(observation).processEvidence?.children.verdict
  }

  function exitPty(): void {
    for (const listener of exitListeners) {
      listener({ exitCode: 0 })
    }
  }

  async function readAfterSettledScan(): Promise<ReturnType<
    NonNullable<SubprocessHandle['observeForegroundProcess']>
  > | null> {
    // A read schedules the next scan rather than awaiting one, and the
    // throttle can swallow the read that follows a scan. Two cycles guarantee
    // one scan both started and settled under the behavior set by this test.
    for (let cycle = 0; cycle < 2; cycle++) {
      handle.observeForegroundProcess?.()
      await vi.advanceTimersByTimeAsync(PAST_THE_SCAN_THROTTLE_MS)
    }
    return handle.observeForegroundProcess?.() ?? null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    resolveAgentForegroundProcessMock.mockReset()
    // Default: a scan that runs and finds no agent. Individual tests override.
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: 'zsh' })
    exitListeners = []
    nodePty = {
      pid: SHELL_PID,
      process: 'zsh',
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn((listener) => {
        exitListeners.push(listener)
        return { dispose: vi.fn() }
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn()
    } as unknown as pty.IPty & { process: string }
    handle = createDaemonPtySubprocessHandle({
      process: nodePty,
      shellPath: '/bin/zsh',
      spawnCwd: '/tmp/wt',
      env: { PATH: '/usr/bin' },
      startupCommandDeliveredInShellArgs: false,
      reportsChildExitStatus: true,
      requestedCwd: '/tmp/wt',
      sessionId: 'repo-observe::/tmp/wt@@observe01',
      startupAgentRecognition: null
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
    vi.restoreAllMocks()
  })

  it('withholds observation from a shell title no scan has corroborated', () => {
    const observation = handle.observeForegroundProcess?.()

    expect(observation?.processName).toBe('zsh')
    expect(observation?.evidence.verdict).toBe('unverifiable')
  })

  it('observes the shell once a completed scan agrees the pane is idle', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: 'zsh' })

    const observation = await readAfterSettledScan()

    expect(observation?.processName).toBe('zsh')
    expect(observation?.evidence).toEqual({ verdict: 'observed', processName: 'zsh' })
  })

  it('withholds observation when the scan ran but could not answer', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: false, processName: 'zsh' })

    const observation = await readAfterSettledScan()

    expect(observation?.evidence.verdict).toBe('unverifiable')
  })

  it('withholds observation after a corroborating scan is followed by a thrown one', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: 'zsh' })
    expect((await readAfterSettledScan())?.evidence.verdict).toBe('observed')

    // A scan that rejects observed nothing; the corroboration it would have
    // refreshed must not be inherited from the last one that succeeded.
    resolveAgentForegroundProcessMock.mockRejectedValue(new Error('ps fork failed'))
    const observation = await readAfterSettledScan()

    expect(observation?.evidence.verdict).toBe('unverifiable')
  })

  it('stops observing a shell title once corroboration ages past the 30s bound', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: 'zsh' })
    expect((await readAfterSettledScan())?.evidence.verdict).toBe('observed')

    // A permanently wedged `ps`: the scan starts and never settles, so nothing
    // refreshes corroboration and it simply ages out. Brackets the 30s bound on
    // both sides so widening or removing it fails here.
    resolveAgentForegroundProcessMock.mockReturnValue(new Promise(() => {}))

    await vi.advanceTimersByTimeAsync(INSIDE_CORROBORATION_WINDOW_MS)
    expect(handle.observeForegroundProcess?.()?.evidence.verdict).toBe('observed')

    await vi.advanceTimersByTimeAsync(PAST_CORROBORATION_WINDOW_MS - INSIDE_CORROBORATION_WINDOW_MS)
    expect(handle.observeForegroundProcess?.()?.evidence.verdict).toBe('unverifiable')
  })

  it('keeps a live agent title an observation without needing a scan', () => {
    nodePty.process = 'codex'

    expect(handle.observeForegroundProcess?.()?.evidence).toEqual({
      verdict: 'observed',
      processName: 'codex'
    })
  })

  it('stops corroborating with a settlement older than an agent the title fast path saw', async () => {
    // The sync fast path stamps a recognized title without running a scan, so the
    // last agent-free settlement can still be inside the 30s window while an agent
    // is running. Corroborating from it publishes a live agent as an idle shell.
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: 'zsh' })
    expect((await readAfterSettledScan())?.evidence.verdict).toBe('observed')

    await vi.advanceTimersByTimeAsync(2_000)
    nodePty.process = 'codex'
    expect(handle.observeForegroundProcess?.()?.evidence).toEqual({
      verdict: 'observed',
      processName: 'codex'
    })

    // A wedged scan never refreshes the settlement, and node-pty's title read
    // falls back to the spawned shell while the agent is still running.
    resolveAgentForegroundProcessMock.mockReturnValue(new Promise(() => {}))
    nodePty.process = 'zsh'
    await vi.advanceTimersByTimeAsync(2_000)

    expect(handle.observeForegroundProcess?.()?.evidence.verdict).toBe('unverifiable')
  })

  it('stops corroborating with a snapshot captured before an agent the scan could not see', async () => {
    // A scan stamps its settlement when it SETTLES, but its process snapshot was taken
    // when it STARTED. An agent that appears in between is invisible to that snapshot,
    // so settle-time ordering alone still lets a pre-agent scan corroborate the shell.
    let settleScan: (value: { available: boolean; processName: string }) => void = () => {}
    resolveAgentForegroundProcessMock.mockReturnValue(
      new Promise<{ available: boolean; processName: string }>((resolve) => {
        settleScan = resolve
      })
    )
    // Starts the agent-free scan; its snapshot is taken now.
    expect(handle.observeForegroundProcess?.()?.evidence.verdict).toBe('unverifiable')

    // The agent starts while that scan is still in flight.
    await vi.advanceTimersByTimeAsync(2_000)
    nodePty.process = 'codex'
    expect(handle.observeForegroundProcess?.()?.evidence).toEqual({
      verdict: 'observed',
      processName: 'codex'
    })

    // Only now does the pre-agent scan settle, so its `at` is newer than the agent stamp.
    await vi.advanceTimersByTimeAsync(1_000)
    settleScan({ available: true, processName: 'zsh' })
    await vi.advanceTimersByTimeAsync(0)

    // The title degrades back to the shell while the agent is still running.
    resolveAgentForegroundProcessMock.mockReturnValue(new Promise(() => {}))
    nodePty.process = 'zsh'
    await vi.advanceTimersByTimeAsync(2_000)

    expect(handle.observeForegroundProcess?.()?.evidence.verdict).toBe('unverifiable')
  })

  it('does not let a pre-agent scan retire the agent it could not see', async () => {
    // The settling scan finds no agent and retires the cached identity — but its snapshot
    // predates that agent. Retiring it hands the same stale scan corroboration by way of
    // the no-evidence arm, so the guard has to hold on both sides.
    let settleScan: (value: { available: boolean; processName: string }) => void = () => {}
    resolveAgentForegroundProcessMock.mockReturnValue(
      new Promise<{ available: boolean; processName: string }>((resolve) => {
        settleScan = resolve
      })
    )
    expect(handle.observeForegroundProcess?.()?.evidence.verdict).toBe('unverifiable')

    await vi.advanceTimersByTimeAsync(2_000)
    nodePty.process = 'codex'
    expect(handle.observeForegroundProcess?.()?.evidence).toEqual({
      verdict: 'observed',
      processName: 'codex'
    })

    // The title degrades back to the shell BEFORE the pre-agent scan settles, so
    // retirement sees a shell on both sides and clears the agent evidence.
    nodePty.process = 'zsh'
    await vi.advanceTimersByTimeAsync(1_000)
    settleScan({ available: true, processName: 'zsh' })
    await vi.advanceTimersByTimeAsync(0)

    resolveAgentForegroundProcessMock.mockReturnValue(new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(handle.observeForegroundProcess?.()?.evidence.verdict).toBe('unverifiable')
  })

  it('leaves the legacy foreground read identical to the observed name', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: false, processName: 'zsh' })
    await readAfterSettledScan()

    // The wire's legacy field must not change shape when evidence degrades.
    expect(handle.getForegroundProcess()).toBe('zsh')
  })

  it('withholds observation when the title read names nothing usable', () => {
    // node-pty's POSIX title read reports an empty name when the native read
    // fails on a live pane, so "no name" is a failed read, not an observed exit.
    nodePty.process = ''

    const observation = observe()

    expect(observation.processName).toBeNull()
    expect(observation.evidence.verdict).toBe('unverifiable')
    expect(childrenVerdict(observation)).toBe('unverifiable')
  })

  it('withholds observation when the title read throws', () => {
    Object.defineProperty(nodePty, 'process', {
      configurable: true,
      get: () => {
        throw new Error('foreground title read failed')
      }
    })

    const observation = observe()

    expect(observation.processName).toBeNull()
    expect(observation.evidence.verdict).toBe('unverifiable')
    expect(childrenVerdict(observation)).toBe('unverifiable')
  })

  it('withholds observation after a corroborating scan is followed by an unavailable one', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: 'zsh' })
    expect((await readAfterSettledScan())?.evidence.verdict).toBe('observed')

    // A scan that ran but could not answer is a relay host's normal steady
    // state. It settles too, so the corroboration it failed to refresh must
    // retire rather than be inherited from the last scan that succeeded.
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: false, processName: 'zsh' })
    const observation = await readAfterSettledScan()

    expect(observation?.evidence.verdict).toBe('unverifiable')
  })

  it('observes the exit node-pty itself reported', () => {
    // The conservative arms must not swallow a real completion: once the host
    // watched the pty exit, absence is something it observed happen.
    exitPty()

    const observation = observe()

    expect(observation.evidence).toEqual({ verdict: 'observed', processName: null })
    expect(childrenVerdict(observation)).toBe('exited')
  })
})
