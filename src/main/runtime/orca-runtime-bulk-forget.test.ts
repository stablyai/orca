// Same-principal bulk forget (§U9 ledger #15 / plan :498): the sibling enumeration
// spans exactly one disconnected remote host, excludes live/other-host/not-stranded
// launches, and STRUCTURALLY excludes automation/orchestration/background-owned
// launches even for the same principal. The bulk mutation forgets each eligible
// sibling through the single-forget reconciler and counts only settled forgets.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AdmissionCapacityRow } from '../agent-launch/agent-launch-admission-store'
import type { ForgetUnknownAgentLaunchResult } from '../../shared/agent-launch-worktree-recovery'

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

vi.mock('../agent-launch/agent-launch-operation-store-host', () => ({
  getHostAgentLaunchOperationStore: () => ({
    // Every enumerated sibling has a pending snapshot naming its operation id.
    findPendingByScope: (scope: string) => ({
      operationId: `op-${scope}`,
      launchToken: `tok-${scope}`
    }),
    recordSettled: () => {},
    clearPending: () => true,
    settleAndClearPending: () => {}
  })
}))

function row(over: Partial<AdmissionCapacityRow>): AdmissionCapacityRow {
  return {
    intent: 'interactive',
    scope: 'wt-1',
    admittedAt: 1,
    launchToken: 'tok',
    baseHarness: 'codex',
    executionHostId: 'ssh:prod',
    ...over
  }
}

// Rows shared by the enumeration tests: one anchor + siblings that each exercise
// one exclusion rule. `strandedScopes` marks which scopes carry a durable
// launch_state_unknown failure in worktree meta.
function scenarioRows(): AdmissionCapacityRow[] {
  return [
    row({ scope: 'wt-anchor', launchToken: 'tok-anchor' }),
    row({ scope: 'wt-sib1', launchToken: 'tok-sib1' }),
    row({ scope: 'wt-sib2', intent: 'cli', launchToken: 'tok-sib2' }),
    // Structural exclusion — same principal + host + stranded, but automation-owned.
    row({ scope: 'run-auto', intent: 'automation', launchToken: 'tok-auto' }),
    // Different disconnected host.
    row({ scope: 'wt-other', executionHostId: 'ssh:other', launchToken: 'tok-other' }),
    // Live terminal owns the token -> not stranded.
    row({ scope: 'wt-live', launchToken: 'tok-live' }),
    // Held reservation but no launch_state_unknown failure yet.
    row({ scope: 'wt-notstranded', launchToken: 'tok-fresh' })
  ]
}

function stubRuntime(
  rows: AdmissionCapacityRow[],
  opts: { liveTokens?: string[]; notStranded?: string[] } = {}
): OrcaRuntimeService {
  capacityMock.mockReturnValue(rows)
  const runtime = new OrcaRuntimeService()
  const notStranded = new Set(opts.notStranded ?? ['wt-notstranded'])
  const internals = runtime as unknown as {
    store: unknown
    ptysById: Map<string, { launchToken: string | null }>
    listResolvedWorktrees: () => Promise<{ id: string }[]>
  }
  internals.store = {
    // No wt-* selector is a registered repo id; the selector guard probes this.
    getRepo: () => undefined,
    getWorktreeMeta: (id: string) =>
      id.startsWith('wt-') && !notStranded.has(id)
        ? { agentLaunchFailure: { code: 'launch_state_unknown' } }
        : id.startsWith('wt-')
          ? {}
          : undefined
  }
  internals.ptysById = new Map(
    (opts.liveTokens ?? ['tok-live']).map((t, i) => [`pty-${i}`, { launchToken: t }])
  )
  // resolveWorktreeSelector('id:<id>') matches by id; every wt-* scope resolves.
  internals.listResolvedWorktrees = async () =>
    rows.filter((r) => r.scope.startsWith('wt-')).map((r) => ({ id: r.scope }))
  return runtime
}

describe('unknownWorktreeAgentLaunchSiblingCount', () => {
  it('counts only same-host, stranded, worktree-owned siblings (excludes the anchor)', async () => {
    const runtime = stubRuntime(scenarioRows())
    const count = await runtime.unknownWorktreeAgentLaunchSiblingCount('id:wt-anchor', undefined)
    // wt-sib1 + wt-sib2 only. wt-other (other host), wt-live (live), wt-notstranded
    // (no failure), and run-auto (automation) are all excluded.
    expect(count).toBe(2)
  })

  it('makes a same-principal automation-owned stranded launch INVISIBLE (ledger #15)', async () => {
    // Only the anchor and a same-host, stranded, automation-owned row exist.
    const runtime = stubRuntime([
      row({ scope: 'wt-anchor', launchToken: 'tok-anchor' }),
      row({ scope: 'wt-auto-owned', intent: 'automation', launchToken: 'tok-auto' })
    ])
    const count = await runtime.unknownWorktreeAgentLaunchSiblingCount('id:wt-anchor', undefined)
    // The automation-owned launch is stranded on the same host under the same
    // principal, yet the intent filter in the enumeration hides it entirely.
    expect(count).toBe(0)
  })

  it('returns 0 for a LOCAL anchor — bulk forget only spans a disconnected remote host', async () => {
    const runtime = stubRuntime([
      row({ scope: 'wt-anchor', executionHostId: 'local', launchToken: 'tok-anchor' }),
      row({ scope: 'wt-sib1', executionHostId: 'local', launchToken: 'tok-sib1' })
    ])
    const count = await runtime.unknownWorktreeAgentLaunchSiblingCount('id:wt-anchor', undefined)
    expect(count).toBe(0)
  })

  it('scopes the principal from clientKind, never client JSON', async () => {
    const runtime = stubRuntime(scenarioRows())
    await runtime.unknownWorktreeAgentLaunchSiblingCount('id:wt-anchor', 'mobile')
    expect(capacityMock).toHaveBeenCalledWith({ kind: 'remote', id: 'mobile' })
  })
})

describe('forgetUnknownWorktreeAgentLaunchSiblings', () => {
  it('forgets exactly the eligible siblings and counts only settled forgets', async () => {
    const runtime = stubRuntime(scenarioRows())
    const forgotten: string[] = []
    const internals = runtime as unknown as {
      forgetUnknownWorktreeAgentLaunch: (
        selector: string,
        args: { expectedOperationId: string; clientMutationId: string }
      ) => Promise<ForgetUnknownAgentLaunchResult>
    }
    // Spy on the single-forget reconciler (tested exhaustively elsewhere): record the
    // selectors, and make one sibling self-reject to prove counting is by outcome.
    internals.forgetUnknownWorktreeAgentLaunch = async (selector, args) => {
      forgotten.push(selector)
      expect(args.expectedOperationId).toBe(`op-${selector.slice(3)}`)
      return selector === 'id:wt-sib2'
        ? { status: 'rejected', requestError: { code: 'stale_agent_launch_failure' } }
        : { status: 'forgotten' }
    }

    const result = await runtime.forgetUnknownWorktreeAgentLaunchSiblings('id:wt-anchor', undefined)

    expect(forgotten).toEqual(['id:wt-sib1', 'id:wt-sib2'])
    // wt-sib1 forgot; wt-sib2 self-rejected -> only 1 counted.
    expect(result.forgottenCount).toBe(1)
  })

  it('forgets nothing for a LOCAL anchor', async () => {
    const runtime = stubRuntime([
      row({ scope: 'wt-anchor', executionHostId: 'local', launchToken: 'tok-anchor' }),
      row({ scope: 'wt-sib1', executionHostId: 'local', launchToken: 'tok-sib1' })
    ])
    const internals = runtime as unknown as {
      forgetUnknownWorktreeAgentLaunch: () => Promise<ForgetUnknownAgentLaunchResult>
    }
    const spy = vi.fn(
      async (): Promise<ForgetUnknownAgentLaunchResult> => ({ status: 'forgotten' })
    )
    internals.forgetUnknownWorktreeAgentLaunch = spy

    const result = await runtime.forgetUnknownWorktreeAgentLaunchSiblings('id:wt-anchor', undefined)

    expect(spy).not.toHaveBeenCalled()
    expect(result.forgottenCount).toBe(0)
  })
})
