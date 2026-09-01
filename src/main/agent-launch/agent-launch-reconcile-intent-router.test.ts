import { describe, expect, it } from 'vitest'
import type { AgentLaunchIntentKind } from '../../shared/agent-launch-contract'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { PendingAgentLaunchSnapshot } from './agent-launch-operation-store'
import {
  reconcilePersistenceForIntent,
  type ReconcileIntentRouterArms
} from './agent-launch-reconcile-intent-router'
import type { ReconcileScopePersistence } from './agent-launch-worktree-reconcile-writer'

function snapshot(): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    mode: 'built-in',
    argv: ['claude'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'darwin',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    }
  }
}

function pending(intent: AgentLaunchIntentKind, scope: string): PendingAgentLaunchSnapshot {
  return {
    operationId: 'op-1',
    idempotencyKey: 'idem-1',
    scope,
    clientMutationId: null,
    payloadDigest: 'digest-1',
    launchToken: 'token-1',
    intent,
    snapshot: snapshot()
  }
}

/** Arms that tag each returned slice with the family + scope it was built for, so
 *  a test can assert which arm handled a given intent and with which owner id. */
function taggingArms(): {
  arms: ReconcileIntentRouterArms
  calls: { family: keyof ReconcileIntentRouterArms; scope: string }[]
} {
  const calls: { family: keyof ReconcileIntentRouterArms; scope: string }[] = []
  const arm =
    (family: keyof ReconcileIntentRouterArms) =>
    (scope: string): ReconcileScopePersistence => {
      calls.push({ family, scope })
      return { settleLaunched: () => {}, settleFailed: () => {}, markUnknown: () => {} }
    }
  return {
    calls,
    arms: {
      worktree: arm('worktree'),
      automation: arm('automation'),
      orchestration: arm('orchestration'),
      background: arm('background')
    }
  }
}

describe('reconcilePersistenceForIntent', () => {
  it('routes interactive, cli, and resume to the worktree arm with the scope id', () => {
    for (const intent of ['interactive', 'cli', 'resume'] as const) {
      const { arms, calls } = taggingArms()
      reconcilePersistenceForIntent(arms, pending(intent, 'wt-1'))
      expect(calls).toEqual([{ family: 'worktree', scope: 'wt-1' }])
    }
  })

  it('routes automation to the automation arm with the run id', () => {
    const { arms, calls } = taggingArms()
    reconcilePersistenceForIntent(arms, pending('automation', 'run-9'))
    expect(calls).toEqual([{ family: 'automation', scope: 'run-9' }])
  })

  it('routes orchestration to the orchestration arm with the dispatch id', () => {
    const { arms, calls } = taggingArms()
    reconcilePersistenceForIntent(arms, pending('orchestration', 'dispatch-7'))
    expect(calls).toEqual([{ family: 'orchestration', scope: 'dispatch-7' }])
  })

  it('routes background to the background arm with the attempt id', () => {
    const { arms, calls } = taggingArms()
    reconcilePersistenceForIntent(arms, pending('background', 'attempt-3'))
    expect(calls).toEqual([{ family: 'background', scope: 'attempt-3' }])
  })

  it('never crosses families when two owners share a scope id namespace', () => {
    const { arms, calls } = taggingArms()
    reconcilePersistenceForIntent(arms, pending('background', 'shared-id'))
    reconcilePersistenceForIntent(arms, pending('automation', 'shared-id'))
    expect(calls).toEqual([
      { family: 'background', scope: 'shared-id' },
      { family: 'automation', scope: 'shared-id' }
    ])
  })
})
