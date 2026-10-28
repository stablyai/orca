import {
  conditionalSnapshotWorkspacePresence,
  conditionalSessionWorkspacePresence
} from '../conditional-workspace-session-presence'
import { getEffectiveHooks } from '../../hooks'
import type {
  ConditionalWorktreeRemoval,
  ConditionalWorktreeRemovalResult
} from '../../../shared/rpc-contract/conditional-worktree-removal'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getLocalProjectWorktreeGitOptions } from '../../project-runtime-git-options'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { hostScopeCensusIsComplete } from '../../../shared/runtime-listing-host-scope'
import { removeConditionalWorktree } from './conditional-worktree-removal'
import type { z } from 'zod'
import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { OrcaRuntimeWithCreateManagedRemoteWorktree } from './workspace-metadata'
import type { RuntimeStore } from '../runtime-store-contract'
import { createConditionalWorkspaceMatcher } from '../conditional-workspace-presence'
import { splitWorktreeId } from '../../../shared/worktree/id'

export abstract class OrcaRuntimeWithConditionalWorktreeRemoval extends OrcaRuntimeWithCreateManagedRemoteWorktree {
  protected abstract conditionalRemovalUserIsViewing(worktreeId: string): boolean | null
  protected abstract purgeRemovedWorktree(
    store: RuntimeStore,
    worktreeId: string,
    repoId: string,
    removalHostId?: ExecutionHostId
  ): void

  async removeManagedWorktreeIfIdle(
    request: z.infer<typeof ConditionalWorktreeRemoval>
  ): Promise<ConditionalWorktreeRemovalResult> {
    const unsupported: ConditionalWorktreeRemovalResult = {
      status: 'refused',
      reason: 'unsupported',
      detail:
        'Requires native Git, main-owned layout, complete local session census and conditional-removal ingress protection.'
    }
    if (
      this.conditionalRemovalUserIsViewing(request.expected.worktreeId) === null ||
      process.platform === 'win32' ||
      !ORCA_LAYOUT_OWNER_IS_MAIN ||
      request.expected.executionHostId !== 'local' ||
      !this.store
    ) {
      return unsupported
    }
    const store = this.store
    const repo = store
      .getRepos()
      .find((row) => row.id === request.expected.repoId && getRepoExecutionHostId(row) === 'local')
    const host = getStructuredAgentSessionHost()
    if (
      !repo ||
      isFolderRepo(repo) ||
      getRepoRoutingConnectionId(repo) ||
      getEffectiveHooks(repo)?.scripts.archive ||
      !host ||
      host.deps.store.readOnly ||
      !store.getProfileStorageDirectory ||
      !store.getWorkspaceSession ||
      !store.getWorkspaceSessionHostIds ||
      Object.keys(getLocalProjectWorktreeGitOptions(store, repo)).length > 0
    ) {
      return unsupported
    }
    const expected = request.expected
    const verifyOccupant = async (): Promise<'same' | 'absent' | 'changed'> => {
      try {
        this.invalidateResolvedWorktreeCache()
        const current = await this.showManagedWorktree(`id:${expected.worktreeId}`)
        return current.repoId === expected.repoId &&
          current.hostId === expected.executionHostId &&
          current.instanceId === expected.instanceId &&
          current.identity?.key === expected.identityKey &&
          current.identity.executionHostId === expected.executionHostId &&
          current.identity.instanceId === expected.instanceId &&
          current.path === expected.checkout.path &&
          current.branch === expected.branch &&
          current.head === expected.head &&
          !current.isMainWorktree &&
          !current.isPinned &&
          current.childWorktreeIds.length === 0
          ? 'same'
          : 'changed'
      } catch (error) {
        if (error instanceof Error && error.message === 'selector_not_found') {
          return 'absent'
        }
        throw error
      }
    }
    return removeConditionalWorktree(request, {
      profileDirectory: store.getProfileStorageDirectory(),
      repoPath: repo.path,
      supported: true,
      verifyOccupant,
      verifyIdle: async (signal) => {
        const viewing = this.conditionalRemovalUserIsViewing(expected.worktreeId)
        if (viewing === null) {
          return 'unknown'
        }
        if (viewing) {
          return 'live'
        }
        const [terminals, inventory] = await Promise.all([
          this.listTerminals(`id:${expected.worktreeId}`, 100, { requireFreshPtyLiveness: true }),
          this.listAllMobileSessionTabsInventory(undefined, signal)
        ])
        if (
          signal.aborted ||
          terminals.truncated ||
          !hostScopeCensusIsComplete(terminals.hostScope) ||
          !terminals.hostScope?.hostIds.includes('local') ||
          inventory.authoritative !== true ||
          terminals.hostScope.omittedHostIds.length > 0
        ) {
          return 'unknown'
        }
        if (terminals.terminals.length > 0 || terminals.totalCount !== 0) {
          return 'live'
        }
        const match = createConditionalWorkspaceMatcher(
          expected.worktreeId,
          expected.executionHostId
        )
        const presence = host.deps.store.conditionalRemovalWorkspacePresence(
          expected.worktreeId,
          expected.executionHostId
        )
        if (presence === 'unknown') {
          return 'unknown'
        }
        if (presence === 'present') {
          return 'live'
        }
        const snapshots = conditionalSnapshotWorkspacePresence(
          inventory.snapshots,
          match,
          (workspace) => {
            const repoId = splitWorktreeId(workspace)?.repoId
            const hosts = new Set(
              store
                .getRepos()
                .filter((row) => row.id === repoId)
                .map(getRepoExecutionHostId)
            )
            return hosts.size === 1 ? hosts.values().next().value : undefined
          }
        )
        if (snapshots !== 'idle') {
          return snapshots
        }
        const partitions = store.getWorkspaceSessionHostIds!()
        if (partitions.length > 100) {
          return 'unknown'
        }
        for (const partition of partitions) {
          const session = store.getWorkspaceSession!(partition)
          const presence = conditionalSessionWorkspacePresence(session, partition, match)
          if (presence !== 'idle') {
            return presence
          }
        }
        return 'idle'
      },
      finishMetadata: async () => {
        this.purgeRemovedWorktree(store, expected.worktreeId, expected.repoId, 'local')
        this.publishWorktreeRemovalChange(expected.repoId)
        this.emitWorktreeLifecycle({
          kind: 'removed',
          worktreeId: expected.worktreeId,
          path: expected.checkout.path
        })
      }
    })
  }
}
