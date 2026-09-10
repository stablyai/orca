import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { completeWorkerTerminalRelease } from './worker-release-completion'

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
      expectedState: 'release_unknown' as const,
      expectedProcessAction: 'closed_agent_terminal' as const,
      expectedLastError:
        'The agent terminal was closed but its process could not be confirmed stopped: its SSH provider is no longer registered.'
    },
    {
      name: 'a bare unconfirmed close',
      close: { handle: 'term_worker', tabId: 'tab-worker', ptyKilled: false },
      expectedState: 'release_unknown' as const,
      expectedProcessAction: 'closed_agent_terminal' as const,
      expectedLastError:
        'The agent terminal was closed but its process could not be confirmed stopped: the stop outcome could not be verified.'
    },
    {
      name: 'an unavailable owning endpoint',
      close: new Error('SSH provider is not connected'),
      expectedState: 'release_pending' as const,
      expectedProcessAction: 'none' as const,
      expectedLastError: 'SSH provider is not connected'
    }
  ])(
    'does not release a worker after $name',
    async ({ close, expectedState, expectedProcessAction, expectedLastError }) => {
      const resource = {
        id: 'resource-1',
        owner_dispatch_id: 'ctx-worker',
        terminal_handle: 'term_worker',
        worktree_id: 'repo::worktree',
        pane_key: 'tab-worker:leaf-worker',
        process_incarnation: 'pty-worker:incarnation-1',
        host_scope: JSON.stringify({ kind: 'ssh', targetId: 'target-1' }),
        archive_source: 'terminal',
        archive_status: 'captured',
        ownership_state: 'owned',
        release_state: 'requested'
      } as WorkerTerminalResourceRow
      const runtime = {
        showTerminal: vi.fn(async () => ({
          handle: 'term_worker',
          worktreeId: 'repo::worktree',
          connected: true
        })),
        getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
        getTerminalProcessIncarnation: vi.fn(() => 'pty-worker:incarnation-1'),
        getTerminalLivenessVerdict: vi.fn(() => ({
          status: 'live' as const,
          ptyIds: ['pty-worker']
        })),
        inspectTerminalProcessIncarnationLiveness: vi.fn(async () => 'unverifiable' as const),
        getExactWorkerProviderSession: vi.fn(() => null),
        getOrchestrationDispatchAuthority: vi.fn(() => ({
          terminalHandle: 'term_worker',
          worktreeId: 'repo::worktree',
          paneKey: 'tab-worker:leaf-worker',
          processIncarnation: 'pty-worker:incarnation-1',
          hostScope: { kind: 'ssh', targetId: 'target-1' }
        })),
        closeTerminal: vi.fn(async () => {
          if (close instanceof Error) {
            throw close
          }
          return close
        }),
        notifyMessageArrived: vi.fn()
      } as unknown as OrcaRuntimeService
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
        getWorkerTerminalArchive: vi.fn(() => ({
          kind: 'transcript_pin',
          resource_id: 'resource-1'
        })),
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
        state: expectedState,
        processAction: expectedProcessAction,
        processVerdict: 'unverifiable',
        lastError: expectedLastError
      })
      if (expectedState === 'release_unknown') {
        expect(markWorkerTerminalReleaseUnknown).toHaveBeenCalledWith(
          'resource-1',
          expectedLastError
        )
      } else {
        expect(markWorkerTerminalReleaseUnknown).not.toHaveBeenCalled()
      }
    }
  )

  it('converges a follow-up stop to exited from owning-host evidence', async () => {
    const resource = {
      id: 'resource-1',
      owner_dispatch_id: 'ctx-worker',
      terminal_handle: 'term_worker',
      worktree_id: 'repo::worktree',
      pane_key: 'tab-worker:leaf-worker',
      process_incarnation: 'pty-worker:incarnation-1',
      host_scope: JSON.stringify({ kind: 'ssh', targetId: 'target-1' }),
      archive_source: 'terminal',
      archive_status: 'captured',
      ownership_state: 'owned',
      release_state: 'requested'
    } as WorkerTerminalResourceRow
    const runtime = {
      showTerminal: vi.fn(async () => ({
        handle: 'term_worker',
        worktreeId: 'repo::worktree',
        connected: true
      })),
      getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
      getTerminalProcessIncarnation: vi.fn(() => 'pty-worker:incarnation-1'),
      getTerminalLivenessVerdict: vi.fn(() => ({
        status: 'live' as const,
        ptyIds: ['pty-worker']
      })),
      getExactWorkerProviderSession: vi.fn(() => null),
      getOrchestrationDispatchAuthority: vi.fn(() => ({
        terminalHandle: 'term_worker',
        worktreeId: 'repo::worktree',
        paneKey: 'tab-worker:leaf-worker',
        processIncarnation: 'pty-worker:incarnation-1',
        hostScope: { kind: 'ssh', targetId: 'target-1' }
      })),
      closeTerminal: vi.fn(async () => ({
        handle: 'term_worker',
        tabId: 'tab-worker',
        ptyKilled: false,
        ptyStopVerdict: 'unverifiable' as const
      })),
      inspectTerminalProcessIncarnationLiveness: vi.fn(async () => 'exited' as const),
      persistExitedWorkerTerminalRetirement: vi.fn(async () => true),
      notifyExitedWorkerTerminalRetirement: vi.fn(),
      notifyMessageArrived: vi.fn()
    } as unknown as OrcaRuntimeService
    const settleWorkerTerminalRelease = vi.fn(() => ({
      ...resource,
      release_state: 'released',
      ownership_state: 'released'
    }))
    const db = {
      getWorkerDispatch: vi.fn(() => ({
        agent_terminal_handle: 'term_worker',
        created_at: '2026-08-16T00:00:00.000Z'
      })),
      isDispatchProcessCurrent: vi.fn(() => true),
      workerTerminalResourceHasIdentityConflict: vi.fn(() => false),
      getWorkerTerminalArchive: vi.fn(() => ({
        kind: 'transcript_pin',
        resource_id: 'resource-1'
      })),
      commitWorkerTerminalArchiveForRelease: vi.fn(() => ({
        ...resource,
        release_state: 'releasing'
      })),
      settleWorkerTerminalRelease
    } as unknown as OrchestrationDb

    await expect(
      completeWorkerTerminalRelease({ runtime, db, dispatchId: 'ctx-worker', resource })
    ).resolves.toMatchObject({
      state: 'released',
      processAction: 'closed_agent_terminal',
      processVerdict: 'exited'
    })
    expect(settleWorkerTerminalRelease).toHaveBeenCalledWith({
      resourceId: resource.id,
      ownerDispatchId: 'ctx-worker',
      processIncarnation: resource.process_incarnation
    })
  })

  it('does not close a terminal whose owning host is unverifiable', async () => {
    const resource = {
      id: 'resource-1',
      terminal_handle: 'term_worker',
      worktree_id: 'repo::worktree',
      pane_key: 'tab-worker:leaf-worker',
      process_incarnation: 'pty-worker:incarnation-1',
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
      getTerminalLivenessVerdict: vi.fn(() => ({
        status: 'unverifiable',
        reason: 'the SSH relay disconnected'
      })),
      getOrchestrationDispatchAuthority: vi.fn(() => ({
        terminalHandle: 'term_worker',
        worktreeId: 'repo::worktree',
        paneKey: 'tab-worker:leaf-worker',
        processIncarnation: 'pty-worker:incarnation-1',
        hostScope: { kind: 'ssh', targetId: 'target-1' }
      })),
      closeTerminal: vi.fn(),
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
      getWorkerTerminalArchive: vi.fn(() => ({
        kind: 'transcript_pin',
        resource_id: 'resource-1'
      })),
      commitWorkerTerminalArchiveForRelease: vi.fn(() => ({
        ...resource,
        release_state: 'releasing'
      })),
      markWorkerTerminalReleaseUnknown,
      recordWorkerTerminalRecoveryAttempt: vi.fn()
    } as unknown as OrchestrationDb

    await expect(
      completeWorkerTerminalRelease({ runtime, db, dispatchId: 'ctx-worker', resource })
    ).resolves.toMatchObject({ state: 'release_unknown', processAction: 'none' })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(markWorkerTerminalReleaseUnknown).toHaveBeenCalledWith(
      'resource-1',
      'The exact worker process is unverifiable: the SSH relay disconnected.'
    )
  })

  it.each([
    { name: 'a stale handle', error: 'terminal_handle_stale' },
    { name: 'a lost endpoint', error: 'endpoint is not connected' }
  ])(
    'settles a host-certified exit without attempting a close that would report $name',
    async ({ error }) => {
      const resource = {
        id: 'resource-1',
        owner_dispatch_id: 'ctx-worker',
        terminal_handle: 'term_worker',
        worktree_id: 'repo::worktree',
        pane_key: 'tab-worker:leaf-worker',
        process_incarnation: 'pty-worker:incarnation-1',
        host_scope: JSON.stringify({ kind: 'ssh', targetId: 'target-1' }),
        archive_source: 'terminal',
        archive_status: 'captured',
        ownership_state: 'owned',
        release_state: 'requested'
      } as WorkerTerminalResourceRow
      const runtime = {
        showTerminal: vi.fn(async () => ({
          handle: 'term_worker',
          worktreeId: 'repo::worktree',
          connected: false,
          ptyId: 'pty-worker',
          incarnationId: 'incarnation-1',
          executionHostId: 'ssh:target-1'
        })),
        getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
        getTerminalProcessIncarnation: vi.fn(() => 'pty-worker:incarnation-1'),
        getTerminalLivenessVerdict: vi.fn(() => ({ status: 'exited' })),
        getOrchestrationDispatchAuthority: vi.fn(() => ({
          terminalHandle: 'term_worker',
          worktreeId: 'repo::worktree',
          paneKey: 'tab-worker:leaf-worker',
          processIncarnation: 'pty-worker:incarnation-1',
          hostScope: { kind: 'ssh', targetId: 'target-1' }
        })),
        getExactWorkerProviderSession: vi.fn(() => null),
        inspectTerminalProcessIncarnationLiveness: vi.fn(async () => 'exited' as const),
        persistExitedWorkerTerminalRetirement: vi.fn(async () => true),
        notifyExitedWorkerTerminalRetirement: vi.fn(),
        closeTerminal: vi.fn(async () => {
          throw new Error(error)
        }),
        notifyMessageArrived: vi.fn()
      } as unknown as OrcaRuntimeService
      const db = {
        getWorkerDispatch: vi.fn(() => ({
          agent_terminal_handle: 'term_worker',
          created_at: '2026-08-16T00:00:00.000Z'
        })),
        isDispatchProcessCurrent: vi.fn(() => true),
        workerTerminalResourceHasIdentityConflict: vi.fn(() => false),
        getWorkerTerminalArchive: vi.fn(() => ({
          kind: 'transcript_pin',
          resource_id: 'resource-1'
        })),
        commitWorkerTerminalArchiveForRelease: vi.fn(() => ({
          ...resource,
          release_state: 'releasing'
        })),
        settleWorkerTerminalRelease: vi.fn(() => ({ ...resource, release_state: 'released' })),
        markWorkerTerminalReleaseUnknown: vi.fn(() => ({ ...resource, release_state: 'unknown' })),
        recordWorkerTerminalRecoveryAttempt: vi.fn()
      } as unknown as OrchestrationDb

      await expect(
        completeWorkerTerminalRelease({ runtime, db, dispatchId: 'ctx-worker', resource })
      ).resolves.toMatchObject({ state: 'released', processAction: 'closed_exited_terminal' })
      expect(runtime.closeTerminal).not.toHaveBeenCalled()
    }
  )
})
