// Receipt-cannot-lie guard for the desktop-local create host-spawn (Ruling 1a):
// the CreatedWorktreeResult's `agentLaunchResult.status: 'launched'` is the sole
// signal the renderer reads to conclude "the host already spawned the primary
// agent terminal", and it must be inseparable from an actual registered PTY. In
// finishLocalWorktreeCreateAgentLaunch the receipt is recorded INSIDE the spawn
// closure, which the transaction runs before settle('registered') and only when
// createTerminal resolves. So a launched outcome implies a recorded receipt, and
// a spawn failure yields `failed` with no receipt — the signal cannot claim a
// primary the host did not spawn. This test drives the same transaction + spawn
// closure shape the runtime method uses.

import { describe, expect, it, vi } from 'vitest'
import { AgentLaunchOperationStore } from './agent-launch-operation-store'
import {
  runWorktreeAgentLaunchTransaction,
  type WorktreeAgentLaunchTransactionDeps
} from './agent-launch-worktree-transaction'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import type { AgentLaunchReceipt } from '../../shared/agent-launch-contract'

const SNAPSHOT: AgentLaunchSnapshot = {
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

const PLAN: AgentStartupPlan = {
  agent: 'claude',
  launchCommand: 'claude',
  expectedProcess: 'claude',
  followupPrompt: null,
  launchConfig: { agentArgs: '', agentEnv: {} }
}

const RECEIPT: AgentLaunchReceipt = {
  requestedAgent: 'claude',
  baseAgent: 'claude',
  notices: [],
  launchToken: 'tok-1',
  catalogRevision: 3,
  telemetry: { agentKind: 'claude-code', usedCustomAgent: false }
}

function buildDeps(
  operationStore: AgentLaunchOperationStore,
  spawn: WorktreeAgentLaunchTransactionDeps['spawn']
): WorktreeAgentLaunchTransactionDeps {
  const boundary = {
    pendingSnapshotFor: vi.fn(() => SNAPSHOT),
    settleAgentLaunch: vi.fn()
  } as unknown as WorktreeAgentLaunchTransactionDeps['boundary']
  return {
    boundary,
    operationStore,
    persistPending: vi.fn(),
    spawn,
    clearPublicPending: vi.fn(),
    persistFailure: vi.fn(),
    mintFailureId: () => 'fail-1',
    now: () => 1000
  }
}

const PARAMS = {
  operationId: 'op-1',
  idempotencyKey: 'idem-1',
  scope: 'wt-1',
  payloadDigest: 'digest-1',
  clientMutationId: null,
  requestedAgent: 'claude' as const,
  intent: 'interactive' as const,
  principal: { kind: 'local' as const },
  execute: async () => ({ ok: true as const, plan: PLAN, receipt: RECEIPT })
}

describe('desktop-local create host-spawn receipt attribution', () => {
  it('records the receipt exactly when the launch registers, so the launched signal is truthful', async () => {
    const operationStore = new AgentLaunchOperationStore()
    // Mirrors finishLocalWorktreeCreateAgentLaunch's spawn closure: createTerminal
    // resolves, then the receipt is attributed to the registered terminal id.
    const spawn = vi.fn(async (_plan: AgentStartupPlan, receipt: AgentLaunchReceipt) => {
      operationStore.recordRegisteredReceipt('term-1', receipt)
      return { terminalId: 'term-1' }
    })
    const outcome = await runWorktreeAgentLaunchTransaction(
      buildDeps(operationStore, spawn),
      PARAMS
    )
    expect(outcome.status).toBe('launched')
    // The launched arm the renderer reads is backed by a recorded receipt.
    expect(operationStore.registeredReceipt('term-1')).toEqual(RECEIPT)
  })

  it('reissues the local-git creation receipt on a settled-launched replay', async () => {
    const operationStore = new AgentLaunchOperationStore()
    // Mirrors createManagedWorktree's inline local-git spawn closure: it now
    // records the receipt just like the other two spawn sites, so the settled
    // ledger (which holds no token by design) can reissue the client-safe
    // receipt from terminal attribution when a create is replayed after restart.
    const spawn = vi.fn(async (_plan: AgentStartupPlan, receipt: AgentLaunchReceipt) => {
      operationStore.recordRegisteredReceipt('local-git-term', receipt)
      return { terminalId: 'local-git-term' }
    })
    const outcome = await runWorktreeAgentLaunchTransaction(
      buildDeps(operationStore, spawn),
      PARAMS
    )
    expect(outcome.status).toBe('launched')
    const terminalId = outcome.status === 'launched' ? outcome.terminalId : null
    expect(terminalId).toBe('local-git-term')
    // resolveSettledWorktreeRetry reads exactly this to reissue `launched`; before
    // the fix a local-git creation left no attribution and returned a stale reject.
    expect(operationStore.registeredReceipt('local-git-term')).toEqual(RECEIPT)
  })

  it('never records a receipt when the spawn fails, so no launched signal can appear', async () => {
    const operationStore = new AgentLaunchOperationStore()
    // createTerminal throws before the receipt line runs — exactly as a real spawn
    // failure would, so no attribution is left behind.
    const spawn = vi.fn(async () => {
      throw new Error('pty_spawn_failed')
    })
    const outcome = await runWorktreeAgentLaunchTransaction(
      buildDeps(operationStore, spawn),
      PARAMS
    )
    expect(outcome.status).toBe('failed')
    expect(operationStore.registeredReceipt('term-1')).toBeNull()
  })
})
