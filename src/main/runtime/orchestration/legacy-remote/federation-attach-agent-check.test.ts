import { afterEach, expect, it, vi } from 'vitest'
import '../db/contract-constants'
import '../db/messages/mailbox-routing-page'
import '../db/dispatch-row-writer'
import '../db/attempt-outcome-projection'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../rpc/core'
import { createWorkerReleaseFixture } from '../../rpc/methods/orchestration/worker/release/worker-release.test-fixture'
import { ORCHESTRATION_FEDERATION_ATTACH_METHODS } from './federation'

afterEach(() => {
  vi.restoreAllMocks()
})

// An older paired home starts its workers here through the legacy attach.
it("refuses an older home's worker whose agent this computer lacks before attaching anything", async () => {
  const { db, runtime } = createWorkerReleaseFixture()
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach reads only the workspace and repo ids.
    { id: 'repo::worktree', repoId: 'repo' } as never
  )
  vi.spyOn(runtime, 'detectProjectLaunchContext').mockResolvedValue({
    agents: ['claude'],
    workspaceKind: 'git-worktree',
    executionContext: { kind: 'ssh' }
  })
  const method = eraseRpcMethods(ORCHESTRATION_FEDERATION_ATTACH_METHODS)[0]!
  if (isStreamingMethod(method)) {
    throw new Error('the attach is a plain method')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach reads only the runtime and its durable request.
  const ctx = {
    runtime,
    orchestrationMutation: {
      callerFingerprint: 'home_peer',
      requestId: 'attach_1',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'hash_1'
    }
  } as unknown as RpcContext
  const refused = await Promise.resolve()
    .then(() =>
      method.handler(
        method.params!.parse({
          dispatchId: 'ctx_attach000001',
          taskId: 'task_attach00001',
          taskSpec: 'work',
          protocolVersion: 3,
          worktree: 'id:repo::worktree',
          agent: 'codex'
        }),
        ctx
      )
    )
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ code: 'worker_agent_unavailable' })
  expect(runtime.createTerminal).not.toHaveBeenCalled()
  expect(db.getRemoteDispatchAttachment('ctx_attach000001')).toBeUndefined()
  db.close()
})
