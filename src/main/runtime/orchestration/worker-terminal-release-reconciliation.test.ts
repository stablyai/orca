import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'
import { completeWorkerTerminalRelease } from '../rpc/methods/orchestration/worker/worker-release-completion'

const DISPATCH_ID = 'ctx-worker'
const RESOURCE_ID = 'resource-worker'
const TERMINAL_HANDLE = 'term-worker'
const WORKTREE_ID = 'repo::worktree'
const PANE_KEY = 'tab-worker:leaf-worker'
const PROCESS_INCARNATION = 'pty-worker:incarnation-1'
const HOST_SCOPE = JSON.stringify({ kind: 'ssh', targetId: 'target-1' })

function workerResource(overrides: Partial<WorkerTerminalResourceRow> = {}) {
  return {
    id: RESOURCE_ID,
    origin_dispatch_id: DISPATCH_ID,
    owner_dispatch_id: DISPATCH_ID,
    prior_owner_dispatch_ids: '[]',
    worktree_id: WORKTREE_ID,
    terminal_handle: TERMINAL_HANDLE,
    pane_key: PANE_KEY,
    process_incarnation: PROCESS_INCARNATION,
    host_scope: HOST_SCOPE,
    endpoint_id: null,
    endpoint_incarnation: null,
    recovery_attempt_count: 0,
    last_recovery_at: null,
    ownership_state: 'owned',
    release_state: 'requested',
    retained_reason: null,
    release_requested_at: '2026-08-28T12:00:00.000Z',
    release_completed_at: null,
    release_error: null,
    archive_source: null,
    archive_status: null,
    created_at: '2026-08-28T12:00:00.000Z',
    updated_at: '2026-08-28T12:00:00.000Z',
    ...overrides
  } satisfies WorkerTerminalResourceRow
}

function releaseFixture(
  options: {
    liveness?: 'live' | 'unverifiable' | 'exited'
    resource?: WorkerTerminalResourceRow
    terminalWorktreeId?: string
    providerSessions?: unknown[]
    archiveResourceId?: string
    liveDispatchAuthority?: boolean
    terminalExecutionHostId?: string
  } = {}
) {
  const resource = options.resource ?? workerResource()
  let archive:
    | { dispatch_id: string; resource_id: string; kind: 'terminal_tail'; content: string }
    | undefined
  const getExactWorkerProviderSession = vi.fn()
  for (const session of options.providerSessions ?? [null, null, null]) {
    getExactWorkerProviderSession.mockReturnValueOnce(session)
  }
  getExactWorkerProviderSession.mockReturnValue(null)
  const runtime = {
    showTerminal: vi.fn(async () => ({
      handle: TERMINAL_HANDLE,
      ptyId: 'pty-worker',
      incarnationId: 'incarnation-1',
      worktreeId: options.terminalWorktreeId ?? WORKTREE_ID,
      connected: false,
      status: 'exited',
      executionHostId: options.terminalExecutionHostId ?? 'ssh:target-1'
    })),
    getTerminalPaneKey: vi.fn(() => PANE_KEY),
    getTerminalProcessIncarnation: vi.fn(() => PROCESS_INCARNATION),
    getTerminalLivenessVerdict: vi.fn(() =>
      options.liveness === 'live'
        ? { status: 'live' as const }
        : options.liveness === 'unverifiable'
          ? { status: 'unverifiable' as const, reason: 'owning host unavailable' }
          : { status: 'exited' as const }
    ),
    getOrchestrationDispatchAuthority: vi.fn(() =>
      options.liveDispatchAuthority === false
        ? null
        : {
            terminalHandle: TERMINAL_HANDLE,
            worktreeId: WORKTREE_ID,
            paneKey: PANE_KEY,
            processIncarnation: PROCESS_INCARNATION,
            hostScope: { kind: 'ssh', targetId: 'target-1' }
          }
    ),
    getExactWorkerProviderSession,
    readTerminal: vi.fn(async () => ({
      handle: TERMINAL_HANDLE,
      status: 'exited',
      tail: [],
      truncated: false,
      nextCursor: null
    })),
    inspectTerminalProcessIncarnationLiveness: vi.fn(async () => options.liveness ?? 'exited'),
    persistExitedWorkerTerminalRetirement: vi.fn(async () => true),
    notifyExitedWorkerTerminalRetirement: vi.fn(),
    closeTerminal: vi.fn(),
    notifyMessageArrived: vi.fn()
  } as unknown as OrcaRuntimeService
  const markWorkerTerminalReleaseUnknown = vi.fn((_resourceId: string, reason: string) => ({
    ...resource,
    release_state: 'unknown' as const,
    release_error: reason,
    archive_source: 'terminal',
    archive_status: 'empty' as const
  }))
  const settleWorkerTerminalRelease = vi.fn(() => ({
    ...resource,
    ownership_state: 'released' as const,
    release_state: 'released' as const,
    archive_source: 'terminal',
    archive_status: 'empty' as const
  }))
  const db = {
    getWorkerDispatch: vi.fn(() => ({
      agent_terminal_handle: TERMINAL_HANDLE,
      created_at: '2026-08-28T12:00:00.000Z'
    })),
    isDispatchProcessCurrent: vi.fn(() => true),
    workerTerminalResourceHasIdentityConflict: vi.fn(() => false),
    getWorkerTerminalArchive: vi.fn(() => archive),
    commitWorkerTerminalArchiveForRelease: vi.fn((params: { content?: string }) => {
      archive = {
        dispatch_id: DISPATCH_ID,
        resource_id: options.archiveResourceId ?? RESOURCE_ID,
        kind: 'terminal_tail',
        content: params.content ?? JSON.stringify({ lines: [], truncated: false })
      }
      return {
        ...resource,
        release_state: 'releasing' as const,
        archive_source: 'terminal',
        archive_status: 'empty' as const
      }
    }),
    markWorkerTerminalReleaseUnknown,
    revertWorkerTerminalReleaseToRetained: vi.fn(() => ({
      ...resource,
      ownership_state: 'owned' as const,
      release_state: 'retained' as const,
      retained_reason: 'identity_unproven' as const
    })),
    settleWorkerTerminalRelease
  } as unknown as OrchestrationDb
  return { runtime, db, resource, markWorkerTerminalReleaseUnknown, settleWorkerTerminalRelease }
}

describe('worker terminal release reconciliation', () => {
  it('releases exact exited-and-archived identity without another close', async () => {
    const fixture = releaseFixture()

    await expect(
      completeWorkerTerminalRelease({
        runtime: fixture.runtime,
        db: fixture.db,
        dispatchId: DISPATCH_ID,
        resource: workerResource()
      })
    ).resolves.toMatchObject({
      state: 'released',
      processAction: 'closed_exited_terminal',
      archive: { source: 'terminal', status: 'empty' }
    })
    expect(fixture.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(fixture.settleWorkerTerminalRelease).toHaveBeenCalledOnce()
  })

  it('releases exact exited identity after live dispatch authority disappears', async () => {
    const fixture = releaseFixture({ liveDispatchAuthority: false })

    await expect(
      completeWorkerTerminalRelease({
        runtime: fixture.runtime,
        db: fixture.db,
        dispatchId: DISPATCH_ID,
        resource: fixture.resource
      })
    ).resolves.toMatchObject({
      state: 'released',
      processAction: 'closed_exited_terminal'
    })
    expect(fixture.runtime.getOrchestrationDispatchAuthority).not.toHaveBeenCalled()
    expect(fixture.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(fixture.settleWorkerTerminalRelease).toHaveBeenCalledOnce()
  })

  it('keeps a WSL lease unknown when exited terminal evidence cannot identify its distro', async () => {
    const fixture = releaseFixture({
      liveDispatchAuthority: false,
      resource: workerResource({
        host_scope: JSON.stringify({ kind: 'wsl', hostId: 'local', distro: 'Ubuntu-24.04' })
      }),
      terminalExecutionHostId: 'local'
    })

    await expect(
      completeWorkerTerminalRelease({
        runtime: fixture.runtime,
        db: fixture.db,
        dispatchId: DISPATCH_ID,
        resource: fixture.resource
      })
    ).resolves.toMatchObject({ state: 'retained', reason: 'identity_unproven' })
    expect(fixture.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(fixture.settleWorkerTerminalRelease).not.toHaveBeenCalled()
  })

  it('uses live host evidence over an exited-looking terminal record', async () => {
    const fixture = releaseFixture({ liveness: 'live' })

    await expect(
      completeWorkerTerminalRelease({
        runtime: fixture.runtime,
        db: fixture.db,
        dispatchId: DISPATCH_ID,
        resource: workerResource()
      })
    ).resolves.toMatchObject({
      state: 'release_unknown',
      processAction: 'none',
      recovery: expect.stringContaining('worker-show')
    })
    expect(fixture.runtime.closeTerminal).toHaveBeenCalledOnce()
    expect(fixture.settleWorkerTerminalRelease).not.toHaveBeenCalled()
  })

  it('keeps an exited-looking terminal unknown when host evidence is unverifiable', async () => {
    const liveness = 'unverifiable' as const
    const fixture = releaseFixture({ liveness })

    await expect(
      completeWorkerTerminalRelease({
        runtime: fixture.runtime,
        db: fixture.db,
        dispatchId: DISPATCH_ID,
        resource: workerResource()
      })
    ).resolves.toMatchObject({
      state: 'release_unknown',
      processAction: 'none',
      recovery: expect.stringContaining('worker-show')
    })
    expect(fixture.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(fixture.settleWorkerTerminalRelease).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'workspace',
      fixture: () =>
        releaseFixture({
          resource: workerResource({ release_state: 'unknown' }),
          terminalWorktreeId: 'repo::replacement'
        })
    },
    {
      name: 'archive receipt',
      fixture: () =>
        releaseFixture({
          resource: workerResource({ release_state: 'unknown' }),
          archiveResourceId: 'resource-replacement'
        })
    },
    {
      name: 'provider session',
      fixture: () =>
        releaseFixture({
          resource: workerResource({ release_state: 'unknown' }),
          providerSessions: [
            null,
            null,
            {
              agent: 'codex',
              processIncarnation: PROCESS_INCARNATION,
              providerSession: { key: 'session', id: 'replacement', transcriptPath: null }
            }
          ]
        })
    }
  ])('keeps a mismatched $name unknown without closing a terminal', async ({ fixture }) => {
    const context = fixture()

    await expect(
      completeWorkerTerminalRelease({
        runtime: context.runtime,
        db: context.db,
        dispatchId: DISPATCH_ID,
        resource: context.resource
      })
    ).resolves.toMatchObject({ state: 'release_unknown', processAction: 'none' })
    expect(context.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(context.settleWorkerTerminalRelease).not.toHaveBeenCalled()
  })
})
