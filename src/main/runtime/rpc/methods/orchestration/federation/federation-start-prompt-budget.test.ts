import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'

describe('federation attach-start prompt budget', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('rejects an 8 MiB Task spec before attachment, worktree, terminal, or prompt effects', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const createAttachment = vi.spyOn(db, 'createRemoteDispatchAttachment')
    const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const writePrompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt')
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )
    if (!method) {
      throw new Error('federationAttachStart method is not registered')
    }

    await expect(
      method.handler(
        method.params!.parse({
          dispatchId: 'ctx_oversized_remote',
          taskId: 'task_oversized_remote',
          taskSpec: 'x'.repeat(8 * 1024 * 1024),
          protocolVersion: 3,
          worktree: 'new-top-level',
          repo: 'remote-repo',
          name: 'oversized-remote-worker',
          agent: 'codex'
        }),
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_oversized_remote',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'oversized_remote_payload'
          }
        }
      )
    ).rejects.toMatchObject({
      code: 'worker_prompt_too_large',
      data: { effectsApplied: false, maxTaskSpecBytes: expect.any(Number) }
    })
    expect(createAttachment).not.toHaveBeenCalled()
    expect(db.getRemoteDispatchAttachment('ctx_oversized_remote')).toBeUndefined()
    expect(db.getMutationReceipt('home_peer', 'request_oversized_remote')).toBeUndefined()
    expect(createWorktree).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
    expect(writePrompt).not.toHaveBeenCalled()
  })
})
