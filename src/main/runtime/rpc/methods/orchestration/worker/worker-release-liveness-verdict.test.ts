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
      markWorkerTerminalReleaseUnknown,
      recordWorkerTerminalRecoveryAttempt: vi.fn()
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

  it.each([
    { name: 'a stale handle', error: 'terminal_handle_stale', state: 'released' },
    { name: 'a lost endpoint', error: 'endpoint is not connected', state: 'release_pending' }
  ])(
    'settles a host-certified exit whose close throws $name as $state',
    async ({ error, state }) => {
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
        getTerminalLivenessVerdict: vi.fn(() => ({ status: 'exited' })),
        getOrchestrationDispatchAuthority: vi.fn(() => ({
          hostScope: { kind: 'ssh', targetId: 'target-1' }
        })),
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
        getWorkerTerminalArchive: vi.fn(() => ({ kind: 'transcript_pin' })),
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
      ).resolves.toMatchObject({ state })
    }
  )
})
