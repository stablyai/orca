import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { ORCHESTRATION_METHODS } from '../../orchestration'

describe('federated unavailable-agent preflight', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('rejects an unavailable agent before persisting an exact-worktree attachment', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preflight reads only repoId before the intentional unavailable-agent rejection.
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder:remote-workspace',
      repoId: 'repo-1'
    } as never)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncherForRepo').mockRejectedValue(
      new OrchestrationError(
        'agent_not_available',
        'Agent launcher codex is not installed on the execution host.'
      )
    )
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }

    await expect(
      method.handler(
        method.params!.parse({
          dispatchId: 'ctx_unavailable',
          taskId: 'task_unavailable',
          taskSpec: 'remote codex worker',
          depth: 2,
          protocolVersion: 3,
          worktree: 'folder:remote-workspace',
          agent: 'codex'
        }),
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_unavailable',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'unavailable_payload'
          }
        }
      )
    ).rejects.toMatchObject({ code: 'agent_not_available' })
    expect(db.getRemoteDispatchAttachment('ctx_unavailable')).toBeUndefined()
    expect(db.getMutationReceipt('home_peer', 'request_unavailable')).toBeUndefined()
  })
})
