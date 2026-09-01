import { describe, it, expect, vi } from 'vitest'
import {
  beginBackgroundDeclarationLaunch,
  settleBackgroundDeclarationResolution,
  settleBackgroundDeclarationSpawn,
  type BackgroundDeclarationDeps
} from './background-agent-launch-spawn-declaration'
import type { AgentLaunchSpawnResolution } from './agent-launch-spawn'
import type { AgentLaunchReceipt } from '../../shared/agent-launch-contract'
import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import type { BackgroundAgentLaunchCreateInput } from './background-agent-launch-store'

const WORKTREE_ID = 'repo-1:wt-a'
const REQUESTED = 'custom-agent:codex:deleted'

function buildDeps(): BackgroundDeclarationDeps & {
  created: BackgroundAgentLaunchCreateInput[]
  settledFailed: { attemptId: string; code: string }[]
  settledLaunched: string[]
  rolledBack: string[]
} {
  const created: BackgroundAgentLaunchCreateInput[] = []
  const settledFailed: { attemptId: string; code: string }[] = []
  const settledLaunched: string[] = []
  const rolledBack: string[] = []
  let attemptSeq = 0
  let opSeq = 0
  let failureSeq = 0
  return {
    created,
    settledFailed,
    settledLaunched,
    rolledBack,
    createAttempt: (input) => created.push(input),
    settleLaunched: (attemptId) => settledLaunched.push(attemptId),
    settleFailed: (attemptId, failure) => settledFailed.push({ attemptId, code: failure.code }),
    rollback: (attemptId) => rolledBack.push(attemptId),
    mintAttemptId: () => `attempt-${(attemptSeq += 1)}`,
    mintOperationId: () => `op-${(opSeq += 1)}`,
    mintFailureId: () => `failure-${(failureSeq += 1)}`,
    now: () => 1000
  }
}

function launchedResolution(): AgentLaunchSpawnResolution {
  const receipt: AgentLaunchReceipt = {
    requestedAgent: REQUESTED,
    baseAgent: 'codex',
    notices: [],
    launchToken: 'token-1',
    catalogRevision: 1,
    telemetry: { agentKind: 'codex', usedCustomAgent: true }
  }
  return { ok: true, plan: {} as AgentStartupPlan, receipt }
}

describe('background declaration handler', () => {
  it('creates the attempt BEFORE resolution with the declared identity and a background intent', () => {
    const deps = buildDeps()
    const launch = beginBackgroundDeclarationLaunch(deps, {
      worktreeId: WORKTREE_ID,
      requestedAgent: REQUESTED
    })

    expect(deps.created).toHaveLength(1)
    expect(deps.created[0]).toEqual({
      attemptId: launch.attemptId,
      worktreeId: WORKTREE_ID,
      operationId: 'op-1',
      // The stale custom id is preserved verbatim so the failed attempt names it.
      requestedAgent: REQUESTED,
      baseAgent: null
    })
    // The host mints its own intent + attempt-keyed scope; the client never sends either.
    expect(launch.intent).toEqual({
      kind: 'background',
      attemptId: launch.attemptId,
      worktreeId: WORKTREE_ID
    })
    expect(launch.scope).toBe(launch.attemptId)
  })

  it('records a durable failed attempt for a resolution failure (survives reload) and retains it', () => {
    const deps = buildDeps()
    const launch = beginBackgroundDeclarationLaunch(deps, {
      worktreeId: WORKTREE_ID,
      requestedAgent: REQUESTED
    })
    const outcome = settleBackgroundDeclarationResolution(deps, launch.attemptId, {
      ok: false,
      failure: { code: 'unknown_agent', requestedAgent: REQUESTED }
    })

    expect(outcome).toEqual({ proceed: false, attemptRetained: true })
    expect(deps.settledFailed).toEqual([{ attemptId: launch.attemptId, code: 'unknown_agent' }])
    expect(deps.rolledBack).toEqual([])
  })

  it('rolls the attempt back for a pre-attempt capacity rejection (admission creates no attempt)', () => {
    const deps = buildDeps()
    const launch = beginBackgroundDeclarationLaunch(deps, {
      worktreeId: WORKTREE_ID,
      requestedAgent: REQUESTED
    })
    const outcome = settleBackgroundDeclarationResolution(deps, launch.attemptId, {
      ok: false,
      failure: { code: 'launch_capacity_exceeded' }
    })

    expect(outcome).toEqual({ proceed: false, attemptRetained: false })
    expect(deps.rolledBack).toEqual([launch.attemptId])
    expect(deps.settledFailed).toEqual([])
  })

  it('rolls the attempt back for a request error', () => {
    const deps = buildDeps()
    const launch = beginBackgroundDeclarationLaunch(deps, {
      worktreeId: WORKTREE_ID,
      requestedAgent: REQUESTED
    })
    const outcome = settleBackgroundDeclarationResolution(deps, launch.attemptId, {
      ok: false,
      requestError: { code: 'idempotency_conflict' }
    })

    expect(outcome).toEqual({ proceed: false, attemptRetained: false })
    expect(deps.rolledBack).toEqual([launch.attemptId])
    expect(deps.settledFailed).toEqual([])
  })

  it('keeps the attempt pending on a successful resolution and settles it on the provider events', () => {
    const deps = buildDeps()
    const launch = beginBackgroundDeclarationLaunch(deps, {
      worktreeId: WORKTREE_ID,
      requestedAgent: REQUESTED
    })
    const outcome = settleBackgroundDeclarationResolution(
      deps,
      launch.attemptId,
      launchedResolution()
    )
    expect(outcome).toEqual({ proceed: true, attemptRetained: true })
    // No settle at resolution time — the attempt stays pending until spawn.
    expect(deps.settledLaunched).toEqual([])
    expect(deps.settledFailed).toEqual([])

    settleBackgroundDeclarationSpawn(deps, launch, 'registered', REQUESTED)
    expect(deps.settledLaunched).toEqual([launch.attemptId])

    // A later spawn-failure settle on a different attempt records spawn_failed.
    const other = beginBackgroundDeclarationLaunch(deps, {
      worktreeId: WORKTREE_ID,
      requestedAgent: REQUESTED
    })
    settleBackgroundDeclarationSpawn(deps, other, 'failed', REQUESTED)
    expect(deps.settledFailed).toEqual([{ attemptId: other.attemptId, code: 'spawn_failed' }])
  })
})

// Exercise the injected now() so the persisted-failure envelope timestamp is covered.
it('stamps the host-minted persisted failure envelope', () => {
  const deps = buildDeps()
  const spy = vi.spyOn(deps, 'settleFailed')
  const launch = beginBackgroundDeclarationLaunch(deps, {
    worktreeId: WORKTREE_ID,
    requestedAgent: REQUESTED
  })
  settleBackgroundDeclarationResolution(deps, launch.attemptId, {
    ok: false,
    failure: { code: 'missing_variable', variable: 'worktreePath' }
  })
  expect(spy).toHaveBeenCalledWith(launch.attemptId, {
    code: 'missing_variable',
    variable: 'worktreePath',
    version: 1,
    failureId: 'failure-1',
    intent: 'background',
    occurredAt: 1000
  })
})
