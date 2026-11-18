import { describe, expect, it } from 'vitest'
import { WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY } from '../../../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { resolveFederatedChildParent } from '../../../../orchestration/legacy-remote-home/federated-worker-child-parent'

const HOME_PARENT = {
  installationId: 'home-installation',
  workspaceKey: 'folder:bot-home' as const,
  instanceId: 'bot-home'
}

// A coordinator terminal in `callerWorkspace`, starting `worker-start --on srv2`.
function resolve(
  worktree: 'new-child' | 'new-top-level',
  callerWorkspace: string,
  resolved: { parent: typeof HOME_PARENT } | { reason: string } = { parent: HOME_PARENT }
) {
  const runtime = {
    showTerminal: async () => ({ worktreeId: callerWorkspace }),
    getOrchestrationDispatchAuthority: () => null,
    showManagedWorktree: async () => ({ displayName: 'Triage', id: callerWorkspace }),
    resolveCallerParentForAnotherStore: async () => ({ ...resolved, source: 'env-workspace' }),
    getRuntimeId: () => 'home-runtime',
    bots: { list: () => [{ folderWorkspaceId: 'bot-home' }] }
  }
  return resolveFederatedChildParent({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only these runtime members.
    runtime: runtime as never,
    worktree,
    from: 'term_coordinator',
    callerSession: undefined,
    serverCapabilities: [WORKTREE_CROSS_STORE_LINEAGE_RUNTIME_CAPABILITY],
    serverName: 'srv2'
  })
}

describe('resolveFederatedChildParent', () => {
  it("nests a bot's new-top-level worker under its home, as a local create there is the bot's", async () => {
    await expect(resolve('new-top-level', 'folder:bot-home')).resolves.toEqual({
      crossStoreParent: HOME_PARENT,
      crossStoreParentInferredFrom: 'orchestration-context'
    })
  })

  it('keeps a non-bot coordinator new-top-level worker top-level', async () => {
    await expect(resolve('new-top-level', 'folder:other')).resolves.toBeUndefined()
  })

  it('starts a bot worker top-level with a warning when its home cannot be named there', async () => {
    await expect(
      resolve('new-top-level', 'folder:bot-home', { reason: "Orca couldn't find it." })
    ).resolves.toEqual({
      warning:
        "Not nested under Triage: Orca couldn't find it, so the worktree was created top-level."
    })
  })
})
