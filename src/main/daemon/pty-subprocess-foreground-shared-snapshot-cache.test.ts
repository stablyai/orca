/**
 * `getProcessTableSnapshot` is a process-wide 500ms cache shared by every pane
 * (process-table-snapshot.ts), so a refresh can be answered from a table another pane
 * captured before this pane's agent existed. The scan's own `startedAt` is the time it
 * ASKED, not the time the table was read, and both ordering guards in
 * foreground-identity-refresh compare against it. Driven through the real resolver and
 * the real cache — a resolver double cannot expose the gap, because the gap is the cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import type * as childProcess from 'node:child_process'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return { ...actual, execFile: execFileMock }
})

import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'
import { buildDaemonInspectProcessResult } from './terminal-host-process-evidence'
import type { SubprocessHandle } from './session-subprocess-handle'
import {
  getProcessTableSnapshot,
  resetProcessTableSnapshotForTests
} from '../../shared/process-table-snapshot'

const SHELL_PID = 999_999_611
const AGENT_PID = 999_999_612
const T0 = 1_700_000_000_000

/** A table with the pane's shell and no agent beneath it: available, and idle. */
const NO_AGENT_TABLE = `${SHELL_PID} 1 Ss+ -zsh\n`
const WITH_AGENT_TABLE = `${SHELL_PID} 1 Ss -zsh\n${AGENT_PID} ${SHELL_PID} S+ codex\n`

describe('foreground scan answered from another pane s cached snapshot', () => {
  let platformDescriptor: PropertyDescriptor | undefined
  let nodePty: pty.IPty & { process: string }
  let handle: SubprocessHandle
  let psOutput: string

  /** The verdict the completion monitor acts on. */
  function childrenVerdict(): string | undefined {
    const observation = handle.observeForegroundProcess?.()
    if (!observation) {
      throw new Error('handle exposes no foreground evidence channel')
    }
    return buildDaemonInspectProcessResult(observation).processEvidence?.children.verdict
  }

  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetProcessTableSnapshotForTests()
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    psOutput = NO_AGENT_TABLE
    execFileMock.mockReset()
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: null, result: { stdout: string }) => void
      ) => {
        callback(null, { stdout: psOutput })
      }
    )
    nodePty = {
      pid: SHELL_PID,
      process: 'zsh',
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
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
      sessionId: 'repo-cache::/tmp/wt@@cache01',
      startupAgentRecognition: null
    })
  })

  afterEach(() => {
    resetProcessTableSnapshotForTests()
    vi.useRealTimers()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
    vi.restoreAllMocks()
  })

  it('does not publish a live agent as an idle shell when the table predates it', async () => {
    // This pane's own first scan, so its refresh throttle is armed from T0.
    handle.observeForegroundProcess?.()
    await settle()
    expect(execFileMock).toHaveBeenCalledTimes(1)

    // T0+900: ANOTHER pane scans. Its snapshot — still agent-free — becomes the shared
    // cache entry, and it is the one this pane will be answered from.
    vi.setSystemTime(T0 + 900)
    await getProcessTableSnapshot()
    expect(execFileMock).toHaveBeenCalledTimes(2)

    // T0+950: the agent starts. The sync title fast path stamps it without any scan.
    vi.setSystemTime(T0 + 950)
    psOutput = WITH_AGENT_TABLE
    nodePty.process = 'codex'
    expect(handle.observeForegroundProcess?.()?.evidence).toEqual({
      verdict: 'observed',
      processName: 'codex'
    })

    // T0+1000: node-pty's title read degrades back to the spawned shell, and the pane's
    // refresh throttle (1s) is up, so a scan runs — and is served the T0+900 table,
    // which never saw the agent. No third `ps` fork proves the cache answered.
    vi.setSystemTime(T0 + 1000)
    nodePty.process = 'zsh'
    handle.observeForegroundProcess?.()
    await settle()
    expect(execFileMock).toHaveBeenCalledTimes(2)

    // The agent is running. Reporting `exited` here is the completion monitor's cue to
    // publish the agent as finished.
    vi.setSystemTime(T0 + 1100)
    expect(childrenVerdict()).toBe('live')
  })

  it('does not let a table captured in the agent s own millisecond retire it', async () => {
    // Same shape, with the cached scan and the agent stamped at the same millisecond.
    // Date.now() cannot order two events inside one tick, and both guards read that tie as
    // "the scan is at least as new as the agent" — the one reading that publishes an exit.
    handle.observeForegroundProcess?.()
    await settle()
    expect(execFileMock).toHaveBeenCalledTimes(1)

    // T0+900: another pane captures an agent-free table, and in that same millisecond the
    // agent starts and the title fast path stamps it. Neither observed the other.
    vi.setSystemTime(T0 + 900)
    await getProcessTableSnapshot()
    expect(execFileMock).toHaveBeenCalledTimes(2)
    psOutput = WITH_AGENT_TABLE
    nodePty.process = 'codex'
    expect(handle.observeForegroundProcess?.()?.evidence).toEqual({
      verdict: 'observed',
      processName: 'codex'
    })

    // T0+1000: the title read degrades to the shell and the throttle is up, so a scan runs
    // and is answered from that same-millisecond table. No third fork: the cache answered.
    vi.setSystemTime(T0 + 1000)
    nodePty.process = 'zsh'
    handle.observeForegroundProcess?.()
    await settle()
    expect(execFileMock).toHaveBeenCalledTimes(2)

    vi.setSystemTime(T0 + 1100)
    expect(childrenVerdict()).toBe('live')
  })

  it('does not corroborate a shell title with a table from the agent s own millisecond', async () => {
    // Past the identity's 1s TTL the corroboration guard is what answers, and it faces the
    // same tie: the only settled scan started in the millisecond the agent was stamped.
    handle.observeForegroundProcess?.()
    await settle()

    vi.setSystemTime(T0 + 900)
    await getProcessTableSnapshot()
    psOutput = WITH_AGENT_TABLE
    nodePty.process = 'codex'
    handle.observeForegroundProcess?.()

    vi.setSystemTime(T0 + 1000)
    nodePty.process = 'zsh'
    handle.observeForegroundProcess?.()
    await settle()
    expect(execFileMock).toHaveBeenCalledTimes(2)

    // T0+2000: the identity is older than its TTL, so the shell title now needs the scan to
    // corroborate it. That scan cannot: it may never have sampled the agent.
    vi.setSystemTime(T0 + 2000)
    expect(childrenVerdict()).toBe('unverifiable')
  })
})
