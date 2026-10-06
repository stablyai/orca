import { describe, expect, it, vi } from 'vitest'
import {
  IMMEDIATE_KILL_CAPTURE_TIMEOUT_MS,
  IMMEDIATE_KILL_REPLY_BUDGET_MS
} from '../daemon/immediate-kill-reply-budget'
import { DESCENDANT_SNAPSHOT_TIMEOUT_MS } from '../pty-descendant-termination'
import { startLateExitHarness } from '../ipc/pty/daemon-late-exit-test-fixture'
import { finishPtyShutdown } from '../ipc/pty/provider/liveness'
import { shutdownProviderAndDetectExit } from '../ipc/pty/provider/shutdown-detect'
import type { PtyRuntimeControllerDeps } from '../ipc/pty/runtime/controller-deps'
import { stopAndWaitPtyFromRuntimeController } from '../ipc/pty/runtime/kill'
import type { OrchestrationDb } from './orchestration/db'
import type { WorkerTerminalResourceRow } from './orchestration/worker-terminal-ownership'
import type { OrcaRuntimeService } from './orca-runtime'
import { EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS } from './orca-runtime-core'
import { completeWorkerTerminalRelease } from './rpc/methods/orchestration/worker/worker-release-completion'

// Longer than the old 2s close budget, like an agent running exit hooks after SIGTERM.
const SLOW_EXIT_MS = 2_300

type Harness = Awaited<ReturnType<typeof startLateExitHarness>>

async function closeThroughDaemon(
  harness: Harness,
  stopAndWait: typeof stopAndWaitPtyFromRuntimeController = stopAndWaitPtyFromRuntimeController
) {
  const ports = {
    runtime: harness.runtime,
    getLocalPtyProviderStartupPromise: () => undefined,
    shutdownProviderAndDetectExit,
    rememberSyntheticKillExit: harness.session.rememberSyntheticKillExit,
    sendPtyExitToRenderer: harness.session.sendPtyExitToRenderer,
    finishPtyShutdown
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exact-stop reads only these controller ports and optional store; spawn ports are unused.
  const deps = ports as unknown as PtyRuntimeControllerDeps
  const fallbackKill = vi.fn(() => true)
  harness.runtime.setPtyController({
    write: () => true,
    getForegroundProcess: async () => null,
    kill: fallbackKill,
    stopAndWait: (id, opts) => stopAndWait(deps, id, opts)
  })
  const terminal = (await harness.runtime.listTerminals()).terminals.find(
    (entry) => entry.ptyId === harness.id
  )
  if (!terminal) {
    throw new Error('Fixture terminal missing')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: release reads only these resource columns.
  const resource = {
    id: 'resource-1',
    terminal_handle: terminal.handle,
    host_scope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    archive_source: 'terminal',
    archive_status: 'captured',
    ownership_state: 'owned',
    release_state: 'requested'
  } as WorkerTerminalResourceRow
  // The release decision reads only the close result; everything before it is stubbed.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: release calls only these runtime methods on the local terminal path.
  const runtime = {
    showTerminal: vi.fn(async () => ({ handle: terminal.handle, connected: true })),
    getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
    getTerminalProcessIncarnation: vi.fn(() => 'pty-worker:incarnation-1'),
    getTerminalLivenessVerdict: vi.fn(() => null),
    getOrchestrationDispatchAuthority: vi.fn(() => ({
      hostScope: { kind: 'local', hostId: 'local' }
    })),
    closeTerminal: (handle: string) => harness.runtime.closeTerminal(handle),
    notifyMessageArrived: vi.fn()
  } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: release calls only these db methods on the local terminal path.
  const db = {
    getWorkerDispatch: vi.fn(() => ({
      agent_terminal_handle: terminal.handle,
      created_at: '2026-08-16T00:00:00.000Z'
    })),
    isDispatchProcessCurrent: vi.fn(() => true),
    workerTerminalResourceHasIdentityConflict: vi.fn(() => false),
    getWorkerTerminalArchive: vi.fn(() => ({ kind: 'transcript_pin' })),
    commitWorkerTerminalArchiveForRelease: vi.fn(() => ({
      ...resource,
      release_state: 'releasing'
    })),
    settleWorkerTerminalRelease: vi.fn(() => ({ ...resource, release_state: 'released' })),
    markWorkerTerminalReleaseUnknown: vi.fn((_id: string, releaseError: string) => ({
      ...resource,
      release_state: 'unknown',
      release_error: releaseError
    })),
    recordWorkerTerminalRecoveryAttempt: vi.fn()
  } as unknown as OrchestrationDb
  const receipt = await completeWorkerTerminalRelease({
    runtime,
    db,
    dispatchId: 'ctx-worker',
    resource
  })
  return { receipt, fallbackKill }
}

describe('worker release of an agent that is slow to exit after its terminal closes', () => {
  it('budgets the close for the daemon immediate-kill verdict, not a fixed 2s', () => {
    expect(EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS).toBeGreaterThan(IMMEDIATE_KILL_REPLY_BUDGET_MS)
    expect(IMMEDIATE_KILL_CAPTURE_TIMEOUT_MS).toBe(DESCENDANT_SNAPSHOT_TIMEOUT_MS)
  })

  it('releases a worker whose process exits after the old 2s budget', async () => {
    const harness = await startLateExitHarness()
    try {
      const subprocess = harness.subprocess
      subprocess.forceKill = () => {
        setTimeout(() => subprocess._simulateExit(0), SLOW_EXIT_MS)
      }
      const startedAt = Date.now()
      const { receipt, fallbackKill } = await closeThroughDaemon(harness)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SLOW_EXIT_MS)
      expect(receipt).toMatchObject({ state: 'released', processAction: 'closed_agent_terminal' })
      expect(fallbackKill).not.toHaveBeenCalled()
      expect(harness.runtime.captureState().liveness).toBe('exited')
    } finally {
      await harness.dispose()
    }
  }, 15_000)

  it('counts a SessionNotFoundError reply for an already-exited process as exited', async () => {
    const harness = await startLateExitHarness()
    try {
      // The exit frame is held back, so main still believes the PTY is live when it closes it.
      harness.pauseStream()
      harness.subprocess._simulateExit(0)
      await vi.waitFor(async () => expect(await harness.adapter.listProcesses()).toEqual([]))
      const { receipt, fallbackKill } = await closeThroughDaemon(harness)
      expect(receipt).toMatchObject({ state: 'released' })
      expect(fallbackKill).not.toHaveBeenCalled()
      harness.resumeStream()
      await harness.waitForExit()
      expect(harness.runtime.captureState().liveness).toBe('exited')
    } finally {
      await harness.dispose()
    }
  })

  it('keeps a process still running when the kill budget expires release_unknown', async () => {
    const harness = await startLateExitHarness()
    // Only Date is faked: the daemon socket and its timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // A wedged agent ignores SIGKILL, so only the close deadline can end the kill.
      harness.subprocess.forceKill = () => {}
      let budgetMs = 0
      const expiringStop: typeof stopAndWaitPtyFromRuntimeController = async (deps, id, opts) => {
        const deadlineMs = opts?.deadlineMs ?? 0
        budgetMs = deadlineMs - Date.now()
        // Jump the clock to the deadline so the real stop issues its kill RPC with no time left.
        vi.setSystemTime(deadlineMs)
        return stopAndWaitPtyFromRuntimeController(deps, id, opts)
      }
      const { receipt, fallbackKill } = await closeThroughDaemon(harness, expiringStop)
      expect(budgetMs).toBeGreaterThan(IMMEDIATE_KILL_REPLY_BUDGET_MS)
      expect(receipt).toMatchObject({
        state: 'release_unknown',
        processAction: 'closed_agent_terminal',
        lastError: expect.stringContaining('could not be confirmed stopped')
      })
      expect(fallbackKill).toHaveBeenCalledTimes(1)
      expect(harness.runtime.captureState().liveness).toBe('unverifiable')
    } finally {
      vi.useRealTimers()
      harness.subprocess._simulateExit(0)
      await harness.dispose()
    }
  })
})
