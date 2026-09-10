import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { FederationAttachStartInput } from '../federation/federation-start-schema'
import { clearWorkerLaunchModelAuthorityCacheForTests } from './worker-launch-model-authority'
import {
  prepareFederationAttachmentWorkerStart,
  prepareLocalWorkerStart
} from './worker-start-validation'
import type { WorkerStartInput } from './worker-start-schema'

/**
 * The selector the model probe receives decides WHICH host answers, so these pin the
 * placement → selector mapping. A refactor that probed the worker's target worktree
 * instead of the coordinator's would still dispatch, and still pass every RPC-level test.
 */
function validationRuntime(): {
  runtime: OrcaRuntimeService
  discover: ReturnType<typeof vi.fn>
  resolveHostKey: ReturnType<typeof vi.fn>
} {
  const resolveHostKey = vi.fn(async () => 'local')
  const discover = vi.fn(async () => ({ success: false, error: 'no CLI' }))
  const runtime = {
    validateOrchestrationAgentLauncher: vi.fn(),
    showTerminal: vi.fn(async () => ({ worktreeId: 'wt_coordinator' })),
    getOrchestrationDispatchAuthority: vi.fn(() => null),
    resolveRuntimeCommitMessageDiscoveryHostKey: resolveHostKey,
    discoverRuntimeCommitMessageModels: discover
  } as unknown as OrcaRuntimeService
  return { runtime, discover, resolveHostKey }
}

function localParams(overrides: Partial<WorkerStartInput>): WorkerStartInput {
  return {
    from: 'term_coord',
    agent: 'claude',
    model: 'opus',
    ...overrides
  } as WorkerStartInput
}

function federatedParams(
  overrides: Partial<FederationAttachStartInput>
): FederationAttachStartInput {
  return {
    runId: 'run_1',
    dispatchId: 'ctx_1',
    taskId: 'task_1',
    taskSpec: 'do the thing',
    protocolVersion: 3,
    worktree: 'remote-worktree',
    agent: 'claude',
    model: 'opus',
    ...overrides
  } as FederationAttachStartInput
}

describe('worker start placement to probe selector', () => {
  beforeEach(() => {
    clearWorkerLaunchModelAuthorityCacheForTests()
  })

  it.each([
    { worktree: 'current', createsWorktree: false },
    { worktree: 'new-child', createsWorktree: true },
    { worktree: 'new-top-level', createsWorktree: true }
  ])(
    'probes the coordinator’s own host for placement $worktree',
    async ({ worktree, createsWorktree }) => {
      const { runtime, resolveHostKey } = validationRuntime()

      await prepareLocalWorkerStart({
        params: localParams({ worktree, ...(createsWorktree ? { name: 'child' } : {}) }),
        createsWorktree,
        runtime
      })

      // A worktree that does not exist yet inherits the host it is about to be made on.
      expect(resolveHostKey).toHaveBeenCalledWith('id:wt_coordinator')
    }
  )

  it.each(['new-child', 'new-top-level'])(
    'probes an explicit destination repo for placement %s',
    async (worktree) => {
      const { runtime, resolveHostKey } = validationRuntime()

      await prepareLocalWorkerStart({
        params: localParams({ worktree, name: 'child', repo: 'id:repo_remote' }),
        createsWorktree: true,
        runtime
      })

      expect(resolveHostKey).toHaveBeenCalledWith({ repoSelector: 'id:repo_remote' })
      expect(runtime.showTerminal).not.toHaveBeenCalled()
    }
  )

  it('probes the named worktree itself when the placement names one', async () => {
    const { runtime, resolveHostKey } = validationRuntime()

    await prepareLocalWorkerStart({
      params: localParams({ worktree: 'id:wt_elsewhere' }),
      createsWorktree: false,
      runtime
    })

    expect(resolveHostKey).toHaveBeenCalledWith('id:wt_elsewhere')
    expect(runtime.showTerminal).not.toHaveBeenCalled()
  })

  it('hands the coordinator’s resolved worktree back so placement need not resolve it again', async () => {
    const { runtime } = validationRuntime()

    const plan = await prepareLocalWorkerStart({
      params: localParams({ worktree: 'current' }),
      createsWorktree: false,
      runtime
    })

    expect(plan.callerWorktreeId).toBe('wt_coordinator')
    expect(runtime.showTerminal).toHaveBeenCalledTimes(1)
  })

  it('probes nothing when no model was requested', async () => {
    const { runtime, resolveHostKey } = validationRuntime()

    await prepareLocalWorkerStart({
      params: localParams({ worktree: 'current', model: undefined }),
      createsWorktree: false,
      runtime
    })

    expect(resolveHostKey).not.toHaveBeenCalled()
    expect(runtime.showTerminal).not.toHaveBeenCalled()
  })

  it('rejects an unsupported model option before resolving or probing a host', async () => {
    const { runtime, discover, resolveHostKey } = validationRuntime()

    await expect(
      prepareLocalWorkerStart({
        params: localParams({ agent: 'grok', model: 'grok-code-fast-1' }),
        createsWorktree: false,
        runtime
      })
    ).rejects.toThrow('Agent grok does not support launch-time model selection.')

    expect(runtime.showTerminal).not.toHaveBeenCalled()
    expect(resolveHostKey).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
  })

  it('does not resolve or probe a host for a pass-through model catalog', async () => {
    const { runtime, discover, resolveHostKey } = validationRuntime()

    const plan = await prepareLocalWorkerStart({
      params: localParams({ agent: 'codex', model: 'account-only-model' }),
      createsWorktree: false,
      runtime
    })

    expect(plan.launch.preferences).toEqual({ model: 'account-only-model' })
    expect(runtime.showTerminal).not.toHaveBeenCalled()
    expect(resolveHostKey).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
  })

  it('probes the remote worktree a federated attachment names', async () => {
    const { runtime, resolveHostKey } = validationRuntime()

    await prepareFederationAttachmentWorkerStart({
      params: federatedParams({}),
      createsWorktree: false,
      runtime
    })

    expect(resolveHostKey).toHaveBeenCalledWith('remote-worktree')
  })

  it('probes the destination repo for a federated new-top-level', async () => {
    const { runtime, resolveHostKey } = validationRuntime()

    await prepareFederationAttachmentWorkerStart({
      params: federatedParams({ name: 'remote-child', repo: 'repo_1' }),
      createsWorktree: true,
      runtime
    })

    expect(resolveHostKey).toHaveBeenCalledWith({ repoSelector: 'repo_1' })
  })
})
