// Runtime wiring for the capacity-recovery pending-summary RPC: derives the
// admission principal from clientKind (own rows only), computes liveness from the
// in-process pty registry (local no-match => absent, remote no-match => unknown),
// resolves the worktree deep link from the store, and never projects the token.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AdmissionCapacityRow } from '../agent-launch/agent-launch-admission-store'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const capacityMock = vi.fn<(principal: unknown) => AdmissionCapacityRow[]>()

vi.mock('../agent-launch/agent-launch-boundary-host', () => ({
  getHostAgentLaunchBoundary: () => ({ capacitySummaryFor: capacityMock })
}))

function stubRuntime(rows: AdmissionCapacityRow[], liveTokens: string[]): OrcaRuntimeService {
  capacityMock.mockReturnValue(rows)
  const runtime = new OrcaRuntimeService()
  const internals = runtime as unknown as {
    store: unknown
    ptysById: Map<string, { launchToken: string | null }>
  }
  internals.store = {
    // Only wt-* scopes name a real worktree; a folder-workspace scope resolves none.
    getWorktreeMeta: (id: string) => (id.startsWith('wt-') ? {} : undefined),
    getSshTarget: (id: string) => (id === 'prod' ? { label: 'Prod box' } : undefined)
  }
  internals.ptysById = new Map(liveTokens.map((t, i) => [`pty-${i}`, { launchToken: t }]))
  return runtime
}

function row(over: Partial<AdmissionCapacityRow>): AdmissionCapacityRow {
  return {
    intent: 'cli',
    scope: 'wt-1',
    admittedAt: 1,
    launchToken: 'tok',
    baseHarness: 'codex',
    executionHostId: 'local',
    ...over
  }
}

describe('pendingAgentLaunchSummary', () => {
  it('derives the admission principal from clientKind (own rows only)', () => {
    const runtime = stubRuntime([], [])
    runtime.pendingAgentLaunchSummary(undefined)
    expect(capacityMock).toHaveBeenLastCalledWith({ kind: 'local' })
    runtime.pendingAgentLaunchSummary('mobile')
    expect(capacityMock).toHaveBeenLastCalledWith({ kind: 'remote', id: 'mobile' })
  })

  it('computes liveness, worktree deep links, and ssh host label without leaking the token', () => {
    const runtime = stubRuntime(
      [
        row({
          scope: 'wt-live',
          launchToken: 'tok-live',
          executionHostId: 'local',
          admittedAt: 10
        }),
        row({
          intent: 'interactive',
          scope: 'wt-remote',
          launchToken: 'tok-gone',
          executionHostId: 'ssh:prod',
          baseHarness: 'claude',
          admittedAt: 20
        }),
        row({
          scope: 'folder-x',
          launchToken: 'tok-local-gone',
          executionHostId: 'local',
          admittedAt: 30
        })
      ],
      ['tok-live']
    )
    const summary = runtime.pendingAgentLaunchSummary(undefined)

    // Token-matched -> live, worktree deep link, local host label.
    expect(summary.rows[0]).toMatchObject({
      sourceKind: 'cli',
      baseHarness: 'codex',
      liveness: 'live',
      deepLink: { kind: 'worktree', worktreeId: 'wt-live' }
    })
    // Remote, no token match -> unknown (never a false absent); ssh alias label.
    expect(summary.rows[1]).toMatchObject({
      liveness: 'unknown',
      targetHostDisplayName: 'Prod box',
      deepLink: { kind: 'worktree', worktreeId: 'wt-remote' }
    })
    // Local, no token match -> absent; folder scope names no worktree -> no link.
    expect(summary.rows[2].liveness).toBe('absent')
    expect(summary.rows[2]).not.toHaveProperty('deepLink')

    const text = JSON.stringify(summary)
    for (const token of ['tok-live', 'tok-gone', 'tok-local-gone']) {
      expect(text).not.toContain(token)
    }
  })
})
