import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { isWorkspaceOwnedBySomeoneElse } from '../../../../../../shared/workspace-creator-visibility'
import { configureFederationWorkerRuntime } from './federation-runtime.test-support'

const HANDLE = 'term_windows_worker'

// A worktree a paired client starts here through orchestration is that client's, as with worktree.create.
describe('federated worker-start creator provenance', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    vi.restoreAllMocks()
  })

  function createWorkerHost(): OrcaRuntimeService {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    configureFederationWorkerRuntime(runtime)
    vi.spyOn(runtime, 'waitForFreshWorkerComposer').mockResolvedValue({
      handle: HANDLE,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    return runtime
  }

  async function attach(
    runtime: OrcaRuntimeService,
    caller: { pairedDeviceId?: string; clientKind?: 'mobile' | 'runtime' }
  ): Promise<unknown> {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }
    return await method.handler(
      method.params!.parse({
        runId: 'run-home',
        dispatchId: 'ctx_remote',
        taskId: 'task_remote',
        taskSpec: 'remote worker',
        protocolVersion: 3,
        worktree: 'new-top-level',
        repo: 'windows-repo',
        name: 'remote-worker',
        agent: 'claude'
      }),
      {
        runtime,
        ...caller,
        orchestrationMutation: {
          callerFingerprint: 'home_peer',
          requestId: 'request_remote',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'remote_payload'
        }
      }
    )
  }

  it('stamps the paired client that asked, so its sidebar keeps the worktree as its own', async () => {
    const runtime = createWorkerHost()

    await expect(
      attach(runtime, { pairedDeviceId: 'device-home', clientKind: 'runtime' })
    ).resolves.toMatchObject({ state: 'ready' })

    const request = vi.mocked(runtime.createManagedWorktree).mock.calls[0]?.[0]
    expect(request?.creatorProvenance).toEqual({ kind: 'paired-device', deviceId: 'device-home' })
    expect(
      isWorkspaceOwnedBySomeoneElse(
        { creatorProvenance: request?.creatorProvenance, runtimeOwnerEnvironmentId: 'env-server' },
        new Map([['env-server', 'device-home']])
      )
    ).toBe(false)
  })

  it('stamps the host when no paired device asked', async () => {
    const runtime = createWorkerHost()

    await expect(attach(runtime, {})).resolves.toMatchObject({ state: 'ready' })

    expect(vi.mocked(runtime.createManagedWorktree).mock.calls[0]?.[0]?.creatorProvenance).toEqual({
      kind: 'host'
    })
  })
})
