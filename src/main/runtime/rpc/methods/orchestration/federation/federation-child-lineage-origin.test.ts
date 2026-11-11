import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import { crossStoreCreateLineage } from '../../../../workspaces/lineage/runtime-worktree-lineage-recording'
import { ORCHESTRATION_METHODS } from '../orchestration'

const PARENT = {
  installationId: 'home-install',
  workspaceKey: 'worktree:repo::/home/parent',
  instanceId: 'parent-instance'
}

describe('a server nesting an orchestration worker under a workspace on another machine', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  async function createdLineage(attach: Record<string, unknown>) {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncherForRepo').mockResolvedValue()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree-creation support reads only id and kind.
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo', kind: 'git' } as never)
    const create = vi
      .spyOn(runtime, 'createManagedWorktree')
      .mockRejectedValue(new Error('stop after create args'))
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.federationAttachStart'
    )!
    await method
      .handler(
        method.params!.parse({
          runId: 'run-home',
          dispatchId: 'ctx_child',
          taskId: 'task_child',
          taskSpec: 'work on the server',
          protocolVersion: 3,
          worktree: 'new-top-level',
          repo: 'repo',
          name: 'child',
          agent: 'codex',
          crossStoreParent: PARENT,
          ...attach
        }),
        {
          runtime,
          orchestrationMutation: {
            callerFingerprint: 'home_peer',
            requestId: 'request_child',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'child_payload'
          }
        }
      )
      .catch(() => undefined)
    const lineage = create.mock.calls[0]?.[0].lineage
    if (!lineage?.crossStoreParent) {
      throw new Error('the server created no nested worktree')
    }
    return crossStoreCreateLineage({ ...lineage, crossStoreParent: lineage.crossStoreParent })
  }

  it('records orchestration as the origin when orchestration picked the parent', async () => {
    await expect(
      createdLineage({ crossStoreParentInferredFrom: 'orchestration-context' })
    ).resolves.toEqual({
      kind: 'crossStore',
      parent: PARENT,
      origin: 'orchestration',
      capture: { source: 'orchestration-context', confidence: 'inferred' }
    })
  })
})
