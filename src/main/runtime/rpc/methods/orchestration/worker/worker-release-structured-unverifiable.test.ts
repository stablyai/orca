import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { completeWorkerTerminalRelease } from './worker-release-completion'
import { inspectWorkerTerminal } from './worker-observation'
import { resolveStructuredWorkerForDispatch } from '../../orchestration-structured-worker-lifecycle'
import { stopStructuredWorkerForRelease } from './structured-worker-release-stop'
import { workerTerminalLeaseIsCurrent } from './worker-terminal-release-lease'

// Why these four modules are mocked wholesale rather than exercised through a real structured
// session: the bug (O3a) is entirely in how completeWorkerTerminalReleaseOnce reacts to the
// *shape* of an observation, not in how that observation is produced -- mocking inspectWorkerTerminal
// directly pins the exact `{ status: 'unverifiable', kind: 'structured' }` answer
// observeStructuredWorker can legitimately give (host not installed, no durable record, non-native
// lease, no attached child) without standing up a full structured-agent-session host.
vi.mock('./worker-observation')
vi.mock('../../orchestration-structured-worker-lifecycle')
vi.mock('./structured-worker-release-stop')
vi.mock('./worker-terminal-release-lease')

describe('orchestration worker release: structured worker unverifiable observation (O3a)', () => {
  it('never completes (or SIGKILLs via the recovery incarnation check) a structured worker release the host reports unverifiable -- only release_unknown, via the real proof-gated stop path', async () => {
    const resource = {
      id: 'resource-1',
      terminal_handle: 'structworker_1',
      host_scope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      archive_source: 'transcript',
      archive_status: 'captured',
      ownership_state: 'owned',
      release_state: 'requested',
      process_incarnation: 'structured:session-1'
    } as WorkerTerminalResourceRow

    // The exact shape observeStructuredWorker returns for e.g. "no attached provider child in
    // this runtime generation" -- a real, host-owned answer, not an absence.
    vi.mocked(inspectWorkerTerminal).mockResolvedValue({
      terminal: null,
      exact: true,
      status: 'unverifiable',
      kind: 'structured',
      reason: 'The session has no attached provider child in this runtime generation.'
    })
    vi.mocked(resolveStructuredWorkerForDispatch).mockReturnValue({
      handle: 'structworker_1',
      sessionId: 'session-1',
      agent: 'claude',
      paneKey: 'tab_worker:leaf',
      processIncarnation: 'structured:session-1',
      worktreeId: 'repo::worktree',
      hostScope: { kind: 'local', hostId: 'local' }
    } as never)
    vi.mocked(workerTerminalLeaseIsCurrent).mockReturnValue(true)
    // The real close attempt cannot prove a stop either -- the honest outcome is release_unknown,
    // never a fabricated 'released'.
    vi.mocked(stopStructuredWorkerForRelease).mockResolvedValue({
      dispatchId: 'ctx-worker',
      state: 'release_unknown',
      processAction: 'none',
      archive: { source: 'transcript', status: 'captured' },
      lastError: 'The structured session close was not proven.',
      recovery: 'retry with the same request id'
    })

    const settleDeadWorkerTerminalRelease = vi.fn(() => ({
      disposition: 'released' as const,
      resource: { ...resource, release_state: 'released' }
    }))
    const runtime = {
      ensureStructuredAgentSessionHost: vi.fn().mockResolvedValue(undefined),
      // A PTY-shaped liveness probe a structured incarnation was never meant to answer -- stubbed
      // to 'exited' so a call to it (the pre-fix path) is unmistakable in the assertion below,
      // whatever the real function would say for an id in this namespace.
      inspectTerminalProcessIncarnationLiveness: vi.fn().mockResolvedValue('exited'),
      notifyMessageArrived: vi.fn()
    } as unknown as OrcaRuntimeService
    const db = {
      getWorkerDispatch: vi.fn(() => ({
        agent_terminal_handle: 'structworker_1',
        created_at: '2026-08-16T00:00:00.000Z'
      })),
      getWorkerTerminalArchive: vi.fn(() => ({ kind: 'transcript_pin' })),
      commitWorkerTerminalArchiveForRelease: vi.fn(() => ({
        ...resource,
        ownership_state: 'owned',
        release_state: 'releasing'
      })),
      settleDeadWorkerTerminalRelease,
      recordWorkerTerminalRecoveryAttempt: vi.fn()
    } as unknown as OrchestrationDb

    const receipt = await completeWorkerTerminalRelease({
      runtime,
      db,
      dispatchId: 'ctx-worker',
      resource,
      mode: 'recovery'
    })

    // Why this proves the fix, not merely an outcome the interactive path would also produce: mode
    // 'recovery' is the one path the pre-fix clause could turn into a settled 'released' (via
    // settleDeadWorkerTerminalRelease, once the PTY-only incarnation-liveness probe answered
    // 'exited') for ANY observation the clause matched -- including a structured host's legitimate
    // 'unverifiable'. Never reaching that probe is the fix; reaching it and answering 'exited' is
    // the bug this test is named for.
    expect(runtime.inspectTerminalProcessIncarnationLiveness).not.toHaveBeenCalled()
    expect(settleDeadWorkerTerminalRelease).not.toHaveBeenCalled()
    expect(stopStructuredWorkerForRelease).toHaveBeenCalled()
    expect(receipt.state).toBe('release_unknown')
    expect(receipt.state).not.toBe('released')
  })
})
