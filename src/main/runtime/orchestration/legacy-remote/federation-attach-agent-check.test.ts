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
it.each([
  { lookupError: null, code: 'worker_agent_unavailable' },
  { lookupError: 'selector_not_found', code: 'worktree_not_found_on_server' },
  { lookupError: 'selector_ambiguous', code: 'invalid_argument' }
])('refuses the start with $code before attaching anything', async ({ lookupError, code }) => {
  const { db, runtime } = createWorkerReleaseFixture()
  const workspace = vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the attach reads only the workspace and repo ids.
    { id: 'repo::worktree', repoId: 'repo' } as never
  )
  if (lookupError) {
    workspace.mockRejectedValue(new Error(lookupError))
  }
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
          agent: 'codex',
          commanderProjectId: lookupError ? 'github:acme/repo' : undefined
        }),
        ctx
      )
    )
    .catch((error: unknown) => error)
  expect(refused).toMatchObject({ code })
  expect(runtime.createTerminal).not.toHaveBeenCalled()
  expect(db.getRemoteDispatchAttachment('ctx_attach000001')).toBeUndefined()
  db.close()
})
