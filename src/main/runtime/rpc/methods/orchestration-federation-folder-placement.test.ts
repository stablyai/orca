import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('orchestration federated folder placement', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('rejects a new folder workspace before accepting the remote attachment', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'folder-repo',
      kind: 'folder'
    } as never)
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }

    await expect(
      method.handler(
        method.params!.parse({
          dispatchId: 'ctx_folder',
          taskId: 'task_folder',
          taskSpec: 'work in folder',
          protocolVersion: 1,
          worktree: 'new-top-level',
          repo: 'folder-repo',
          name: 'folder-worker',
          agent: 'codex',
          dispatchGroup: 'folder-worker',
          dispatchIndex: 1,
          maxDispatches: 1,
          maxRuntimeMs: 60_000,
          maxRequests: 10,
          maxReviewCycles: 0,
          deadlineAt: new Date(Date.now() + 60_000).toISOString()
        }),
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_folder',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'folder_payload'
          }
        }
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        'Folder projects cannot create orchestration worktrees; use an exact existing folder workspace.'
    })
    expect(db.getRemoteDispatchAttachment('ctx_folder')).toBeUndefined()
    expect(db.getMutationReceipt('home_peer', 'request_folder')).toBeUndefined()
  })
})
