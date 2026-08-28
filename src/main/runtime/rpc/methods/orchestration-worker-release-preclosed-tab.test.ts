import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import { completeWorkerTerminalRelease } from './orchestration-worker-release-completion'

describe('orchestration worker release after its tab was already closed', () => {
  it.each([
    {
      processLiveness: 'exited' as const,
      postCloseProcessLiveness: 'exited' as const,
      incarnationChangesDuringLiveness: false,
      incarnationChangesOnClose: false,
      closeError: null,
      closeRefusedReason: null,
      expectedState: 'released',
      expectedProcessAction: 'closed_exited_terminal',
      settles: true,
      expectedCloseAttempts: 1,
      marksUnknown: false
    },
    {
      processLiveness: 'live' as const,
      postCloseProcessLiveness: 'live' as const,
      incarnationChangesDuringLiveness: false,
      incarnationChangesOnClose: false,
      closeError: null,
      closeRefusedReason: null,
      expectedState: 'release_unknown',
      expectedProcessAction: 'closed_agent_terminal',
      settles: false,
      expectedCloseAttempts: 1,
      marksUnknown: true
    },
    {
      processLiveness: 'unverifiable' as const,
      postCloseProcessLiveness: 'unverifiable' as const,
      incarnationChangesDuringLiveness: false,
      incarnationChangesOnClose: false,
      closeError: null,
      closeRefusedReason: null,
      expectedState: 'release_unknown',
      expectedProcessAction: 'closed_agent_terminal',
      settles: false,
      expectedCloseAttempts: 1,
      marksUnknown: true
    },
    {
      processLiveness: 'exited' as const,
      postCloseProcessLiveness: 'exited' as const,
      incarnationChangesDuringLiveness: false,
      incarnationChangesOnClose: true,
      closeError: null,
      closeRefusedReason: null,
      expectedState: 'retained',
      expectedProcessAction: 'none',
      settles: false,
      expectedCloseAttempts: 1,
      marksUnknown: false
    },
    {
      processLiveness: 'exited' as const,
      postCloseProcessLiveness: 'exited' as const,
      incarnationChangesDuringLiveness: true,
      incarnationChangesOnClose: false,
      closeError: null,
      closeRefusedReason: null,
      expectedState: 'retained',
      expectedProcessAction: 'none',
      settles: false,
      expectedCloseAttempts: 0,
      marksUnknown: false
    },
    {
      processLiveness: 'exited' as const,
      postCloseProcessLiveness: 'exited' as const,
      incarnationChangesDuringLiveness: false,
      incarnationChangesOnClose: false,
      closeError: 'tab_not_found',
      closeRefusedReason: null,
      expectedState: 'released',
      expectedProcessAction: 'none',
      settles: true,
      expectedCloseAttempts: 1,
      marksUnknown: false
    },
    {
      processLiveness: 'exited' as const,
      postCloseProcessLiveness: 'live' as const,
      incarnationChangesDuringLiveness: false,
      incarnationChangesOnClose: false,
      closeError: 'tab_not_found',
      closeRefusedReason: null,
      expectedState: 'release_unknown',
      expectedProcessAction: 'none',
      settles: false,
      expectedCloseAttempts: 1,
      marksUnknown: true
    },
    {
      processLiveness: 'exited' as const,
      postCloseProcessLiveness: 'exited' as const,
      incarnationChangesDuringLiveness: false,
      incarnationChangesOnClose: false,
      closeError: null,
      closeRefusedReason: 'incarnation_replaced' as const,
      expectedState: 'retained',
      expectedProcessAction: 'none',
      settles: false,
      expectedCloseAttempts: 1,
      marksUnknown: false
    },
    {
      processLiveness: 'exited' as const,
      postCloseProcessLiveness: 'exited' as const,
      incarnationChangesDuringLiveness: false,
      incarnationChangesOnClose: true,
      closeError: null,
      closeRefusedReason: null,
      closePtyKilled: true,
      expectedState: 'retained',
      expectedProcessAction: 'none',
      settles: false,
      expectedCloseAttempts: 1,
      marksUnknown: false
    }
  ])(
    'handles process=$processLiveness postClose=$postCloseProcessLiveness close=$closeError refusal=$closeRefusedReason killed=$closePtyKilled changeDuringCheck=$incarnationChangesDuringLiveness changeOnClose=$incarnationChangesOnClose',
    async ({
      processLiveness,
      postCloseProcessLiveness,
      incarnationChangesDuringLiveness,
      incarnationChangesOnClose,
      closeError,
      closeRefusedReason,
      closePtyKilled = false,
      expectedState,
      expectedProcessAction,
      settles,
      expectedCloseAttempts,
      marksUnknown
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
      let closeAttempted = false
      let processLivenessChecked = false
      const runtime = {
        showTerminal: vi.fn(async () => ({ handle: 'term_worker', connected: false })),
        getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
        getTerminalProcessIncarnation: vi.fn(() =>
          (processLivenessChecked && incarnationChangesDuringLiveness) ||
          (closeAttempted && incarnationChangesOnClose)
            ? 'pty-worker:incarnation-2'
            : 'pty-worker:incarnation-1'
        ),
        getTerminalLivenessVerdict: vi.fn(() => ({ status: 'exited' as const })),
        inspectTerminalProcessIncarnationLiveness: vi.fn(async () => {
          processLivenessChecked = true
          return closeAttempted ? postCloseProcessLiveness : processLiveness
        }),
        getOrchestrationDispatchAuthority: vi.fn(() => null),
        closeTerminal: vi.fn(async () => {
          closeAttempted = true
          if (closeError) {
            throw new Error(closeError)
          }
          return {
            handle: 'term_worker',
            tabId: 'tab-worker',
            ptyKilled: closePtyKilled,
            ...(closeRefusedReason ? { closeRefusedReason } : {})
          }
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
        isDispatchProcessCurrent: vi.fn(
          ({ processIncarnation }: { processIncarnation: string | null }) =>
            processIncarnation === 'pty-worker:incarnation-1'
        ),
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
        archive: { source: 'terminal', status: 'captured' }
      })
      expect(runtime.inspectTerminalProcessIncarnationLiveness).toHaveBeenCalledWith(
        'pty-worker:incarnation-1',
        resource.host_scope
      )
      expect(runtime.inspectTerminalProcessIncarnationLiveness).toHaveBeenCalledTimes(
        closeError ? 2 : 1
      )
      expect(runtime.closeTerminal).toHaveBeenCalledTimes(expectedCloseAttempts)
      if (expectedCloseAttempts > 0) {
        expect(runtime.closeTerminal).toHaveBeenCalledWith('term_worker', {
          expectedProcessIncarnation: 'pty-worker:incarnation-1'
        })
      }
      if (settles) {
        expect(settleWorkerTerminalRelease).toHaveBeenCalledWith('resource-1')
        expect(markWorkerTerminalReleaseUnknown).not.toHaveBeenCalled()
      } else {
        expect(settleWorkerTerminalRelease).not.toHaveBeenCalled()
        expect(markWorkerTerminalReleaseUnknown).toHaveBeenCalledTimes(marksUnknown ? 1 : 0)
      }
    }
  )
})
