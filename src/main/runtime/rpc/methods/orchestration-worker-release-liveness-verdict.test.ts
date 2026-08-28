import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import { completeWorkerTerminalRelease } from './orchestration-worker-release-completion'

describe('orchestration worker release liveness verdict', () => {
  it.each([
    {
      name: 'an explicit unverifiable verdict',
      close: {
        handle: 'term_worker',
        tabId: 'tab-worker',
        ptyKilled: false,
        ptyStopVerdict: 'unverifiable' as const,
        ptyStopReason: 'its SSH provider is no longer registered'
      },
      detail: 'its SSH provider is no longer registered'
    },
    {
      name: 'a bare unconfirmed close',
      close: { handle: 'term_worker', tabId: 'tab-worker', ptyKilled: false },
      detail: 'the stop outcome could not be verified'
    }
  ])('does not release a worker after $name', async ({ close, detail }) => {
    const reason = 'its SSH provider is no longer registered'
    const resource = {
      id: 'resource-1',
      terminal_handle: 'term_worker',
      host_scope: JSON.stringify({ kind: 'ssh', targetId: 'target-1' }),
      archive_source: 'terminal',
      archive_status: 'captured',
      ownership_state: 'owned',
      release_state: 'requested'
    } as WorkerTerminalResourceRow
    const runtime = {
      showTerminal: vi.fn(async () => ({ handle: 'term_worker', connected: false })),
      getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
      getTerminalProcessIncarnation: vi.fn(() => 'pty-worker:incarnation-1'),
      getTerminalLivenessVerdict: vi.fn(() => ({ status: 'unverifiable', reason })),
      getOrchestrationDispatchAuthority: vi.fn(() => ({
        hostScope: { kind: 'ssh', targetId: 'target-1' }
      })),
      closeTerminal: vi.fn(async () => close),
      notifyMessageArrived: vi.fn()
    } as unknown as OrcaRuntimeService
    const markWorkerTerminalReleaseUnknown = vi.fn((_resourceId: string, releaseError: string) => ({
      ...resource,
      release_state: 'unknown',
      release_error: releaseError
    }))
    const db = {
      getWorkerDispatch: vi.fn(() => ({
        agent_terminal_handle: 'term_worker',
        created_at: '2026-08-16T00:00:00.000Z'
      })),
      isDispatchProcessCurrent: vi.fn(() => true),
      workerTerminalResourceHasIdentityConflict: vi.fn(() => false),
      getWorkerTerminalArchive: vi.fn(() => ({ kind: 'transcript_pin' })),
      commitWorkerTerminalArchiveForRelease: vi.fn(() => ({
        ...resource,
        release_state: 'releasing'
      })),
      markWorkerTerminalReleaseUnknown
    } as unknown as OrchestrationDb

    await expect(
      completeWorkerTerminalRelease({
        runtime,
        db,
        dispatchId: 'ctx-worker',
        resource
      })
    ).resolves.toMatchObject({
      state: 'release_unknown',
      processAction: 'closed_agent_terminal',
      lastError: `The agent terminal was closed but its process could not be confirmed stopped: ${detail}.`
    })
    expect(markWorkerTerminalReleaseUnknown).toHaveBeenCalledWith(
      'resource-1',
      `The agent terminal was closed but its process could not be confirmed stopped: ${detail}.`
    )
  })

  // Why every row pins one half of the guard: settling an absent tab is only safe when the exact
  // worker was observed exited AND the close failed for exactly that absence. Rows that exercise
  // only one half would let the other be widened without a red test.
  it.each([
    {
      name: 'an exact exited worker after its tab was removed',
      connected: false,
      verdict: { status: 'exited' as const },
      closeError: 'tab_not_found',
      currentProcessIncarnation: 'pty-worker:incarnation-1',
      processLiveness: 'exited' as const,
      dispatchAuthority: null,
      expectedState: 'released',
      expectedProcessAction: 'none',
      settles: true,
      rechecksProcess: true
    },
    {
      name: 'an exact exited worker',
      connected: false,
      verdict: { status: 'exited' as const },
      closeError: 'tab_not_found',
      currentProcessIncarnation: 'pty-worker:incarnation-1',
      processLiveness: 'exited' as const,
      expectedState: 'released',
      expectedProcessAction: 'none',
      settles: true,
      rechecksProcess: true
    },
    {
      name: 'a live worker',
      connected: true,
      verdict: { status: 'live' as const },
      closeError: 'tab_not_found',
      currentProcessIncarnation: 'pty-worker:incarnation-1',
      processLiveness: 'live' as const,
      expectedState: 'release_unknown',
      expectedProcessAction: 'none',
      settles: false,
      rechecksProcess: false
    },
    {
      // An observed exit is not a blank cheque: only an absent tab proves the close itself finished.
      name: 'an exact exited worker whose handle went stale',
      connected: false,
      verdict: { status: 'exited' as const },
      closeError: 'terminal_handle_stale',
      currentProcessIncarnation: 'pty-worker:incarnation-1',
      processLiveness: 'exited' as const,
      expectedState: 'release_unknown',
      expectedProcessAction: 'none',
      settles: false,
      rechecksProcess: false
    },
    {
      // Lost contact is not a death certificate; an absent tab cannot settle an unobserved process.
      name: 'a worker whose liveness we lost contact with',
      connected: false,
      verdict: {
        status: 'unverifiable' as const,
        reason: 'its SSH provider is no longer registered'
      },
      closeError: 'tab_not_found',
      currentProcessIncarnation: 'pty-worker:incarnation-1',
      processLiveness: 'unverifiable' as const,
      expectedState: 'release_unknown',
      expectedProcessAction: 'none',
      settles: false,
      rechecksProcess: false
    },
    {
      name: 'an exact exited worker whose process is still listed',
      connected: false,
      verdict: { status: 'exited' as const },
      closeError: 'tab_not_found',
      currentProcessIncarnation: 'pty-worker:incarnation-1',
      processLiveness: 'live' as const,
      expectedState: 'release_unknown',
      expectedProcessAction: 'none',
      settles: false,
      rechecksProcess: true
    },
    {
      name: 'an exact exited worker whose process can no longer be verified',
      connected: false,
      verdict: { status: 'exited' as const },
      closeError: 'tab_not_found',
      currentProcessIncarnation: 'pty-worker:incarnation-1',
      processLiveness: 'unverifiable' as const,
      expectedState: 'release_unknown',
      expectedProcessAction: 'none',
      settles: false,
      rechecksProcess: true
    },
    {
      name: 'an exact exited worker whose process incarnation changed',
      connected: false,
      verdict: { status: 'exited' as const },
      closeError: 'tab_not_found',
      currentProcessIncarnation: 'pty-worker:incarnation-2',
      processLiveness: 'exited' as const,
      expectedState: 'release_unknown',
      expectedProcessAction: 'none',
      settles: false,
      rechecksProcess: false
    },
    {
      name: 'an exact exited worker whose process incarnation disappeared',
      connected: false,
      verdict: { status: 'exited' as const },
      closeError: 'tab_not_found',
      currentProcessIncarnation: null,
      processLiveness: 'exited' as const,
      expectedState: 'release_unknown',
      expectedProcessAction: 'none',
      settles: false,
      rechecksProcess: false
    },
    {
      name: 'an exact exited worker whose process oracle failed',
      connected: false,
      verdict: { status: 'exited' as const },
      closeError: 'tab_not_found',
      currentProcessIncarnation: 'pty-worker:incarnation-1',
      processLiveness: 'throws' as const,
      expectedState: 'release_unknown',
      expectedProcessAction: 'none',
      settles: false,
      rechecksProcess: true
    }
  ])(
    'handles $closeError after trying to close $name',
    async ({
      connected,
      verdict,
      closeError,
      currentProcessIncarnation,
      processLiveness,
      dispatchAuthority,
      expectedState,
      expectedProcessAction,
      settles,
      rechecksProcess
    }) => {
      const resource = {
        id: 'resource-1',
        terminal_handle: 'term_worker',
        process_incarnation: 'pty-worker:incarnation-1',
        host_scope: JSON.stringify({ kind: 'local', hostId: 'local' }),
        archive_source: 'terminal',
        archive_status: 'captured',
        ownership_state: 'owned',
        release_state: 'requested'
      } as WorkerTerminalResourceRow
      const runtime = {
        showTerminal: vi.fn(async () => ({ handle: 'term_worker', connected })),
        getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
        getTerminalProcessIncarnation: vi.fn(() => currentProcessIncarnation),
        getTerminalLivenessVerdict: vi.fn(() => verdict),
        inspectTerminalProcessIncarnationLiveness: vi.fn(async () => {
          if (processLiveness === 'throws') {
            throw new Error('listProcesses failed')
          }
          return processLiveness
        }),
        getOrchestrationDispatchAuthority: vi.fn(() =>
          dispatchAuthority === null ? null : { hostScope: { kind: 'local', hostId: 'local' } }
        ),
        closeTerminal: vi.fn(async () => {
          throw new Error(closeError)
        }),
        notifyMessageArrived: vi.fn()
      } as unknown as OrcaRuntimeService
      const settleWorkerTerminalRelease = vi.fn(() => ({
        ...resource,
        ownership_state: 'released',
        release_state: 'released'
      }))
      const markWorkerTerminalReleaseUnknown = vi.fn(
        (_resourceId: string, releaseError: string) => ({
          ...resource,
          release_state: 'unknown',
          release_error: releaseError
        })
      )
      const db = {
        getWorkerDispatch: vi.fn(() => ({
          agent_terminal_handle: 'term_worker',
          created_at: '2026-08-16T00:00:00.000Z'
        })),
        isDispatchProcessCurrent: vi.fn(() => true),
        workerTerminalResourceHasIdentityConflict: vi.fn(() => false),
        getWorkerTerminalArchive: vi.fn(() => ({ kind: 'transcript_pin' })),
        commitWorkerTerminalArchiveForRelease: vi.fn(() => ({
          ...resource,
          release_state: 'releasing'
        })),
        revertWorkerTerminalReleaseToRetained: vi.fn(() => ({
          ...resource,
          release_state: 'retained',
          retained_reason: 'identity_unproven'
        })),
        settleWorkerTerminalRelease,
        markWorkerTerminalReleaseUnknown
      } as unknown as OrchestrationDb

      await expect(
        completeWorkerTerminalRelease({
          runtime,
          db,
          dispatchId: 'ctx-worker',
          resource
        })
      ).resolves.toMatchObject({
        state: expectedState,
        processAction: expectedProcessAction,
        // The frozen archive must survive either verdict; a settled release that forgets it
        // would strand the only readable record of the worker's output.
        archive: { source: 'terminal', status: 'captured' }
      })
      if (rechecksProcess) {
        expect(runtime.inspectTerminalProcessIncarnationLiveness).toHaveBeenCalledWith(
          'pty-worker:incarnation-1',
          resource.host_scope
        )
        expect(runtime.inspectTerminalProcessIncarnationLiveness).toHaveBeenCalledTimes(1)
      } else {
        expect(runtime.inspectTerminalProcessIncarnationLiveness).not.toHaveBeenCalled()
      }
      if (settles) {
        expect(settleWorkerTerminalRelease).toHaveBeenCalledWith('resource-1')
        expect(settleWorkerTerminalRelease).toHaveBeenCalledTimes(1)
        expect(markWorkerTerminalReleaseUnknown).not.toHaveBeenCalled()
        // Without this the coordinator never wakes on the release it is blocked on.
        expect(runtime.notifyMessageArrived).toHaveBeenCalledWith('dispatch:ctx-worker', 'status')
        expect(runtime.notifyMessageArrived).toHaveBeenCalledTimes(1)
        return
      }
      expect(settleWorkerTerminalRelease).not.toHaveBeenCalled()
      expect(markWorkerTerminalReleaseUnknown).toHaveBeenCalledWith('resource-1', closeError)
      expect(markWorkerTerminalReleaseUnknown).toHaveBeenCalledTimes(1)
      // An unsettled release must not announce itself as a completed one.
      expect(runtime.notifyMessageArrived).not.toHaveBeenCalled()
    }
  )
})
