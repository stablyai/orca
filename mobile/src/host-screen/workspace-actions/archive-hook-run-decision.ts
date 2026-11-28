import type { PersistedTrustedOrcaHooks } from '../../../../src/shared/workspace-setup/orca-yaml-hook-types'
import { projectGroupIdFromRepoId } from '../../../../src/shared/folder-workspaces/folder-workspace-worktree'
import { projectGroupHookTrustKey } from '../../../../src/shared/workspace-setup/hooks/workspace-hook-owner'
import type { OrcaHookTrustPrompt } from '../../components/hook-trust/OrcaHookTrustDrawer'
import { newWorkspaceUiStateRead } from '../../new-workspace/creation/runtime/new-workspace-operations'
import {
  isOrcaHookTrusted,
  usesVersionedOrcaHookTrust,
  wasOrcaHookPreviouslyApproved
} from '../../new-workspace/creation/setup-hook-trust'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { worktreeArchiveHookTrustRead } from '../host-screen-operations'
import type { RowClients } from './use-host-worktree-delete'

type ArchiveHookDecision =
  | { kind: 'run' | 'skip' }
  | {
      kind: 'ask'
      prompt: OrcaHookTrustPrompt
      trust: PersistedTrustedOrcaHooks
      repos: readonly { id: string }[] | null
    }

// Desktop's ensureHooksConfirmed('archive'): a script that cannot be inspected or checked against trust does not run.
export async function decideArchiveHookRun(
  args: RowClients & {
    repos: readonly { id: string }[] | null
    item: Worktree
    approvedArchiveHash?: string
  }
): Promise<ArchiveHookDecision> {
  const { repoId } = args.item
  const groupId = projectGroupIdFromRepoId(repoId)
  // Project-group hooks share desktop's host-scoped trust key so approvals match across clients.
  const trustRepoId = groupId
    ? projectGroupHookTrustKey({ id: groupId, executionHostId: args.item.hostId })
    : repoId
  try {
    const hooks = worktreeArchiveHookTrustRead.interpret(
      await worktreeArchiveHookTrustRead.request(args.rowClient, { repo: `id:${repoId}` })
    )
    if (!hooks.accepted || hooks.value === undefined) {
      return { kind: 'skip' }
    }
    const archiveTrust = hooks.value
    if (archiveTrust === null) {
      return { kind: 'run' }
    }
    // Trust lives on the paired desktop, whichever host owns the workspace.
    const ui = newWorkspaceUiStateRead.interpret(
      await newWorkspaceUiStateRead.request(args.desktopClient)
    )
    if (!ui.accepted) {
      return { kind: 'skip' }
    }
    const trust = ui.value?.trustedOrcaHooks ?? {}
    if (
      archiveTrust.contentHash === args.approvedArchiveHash ||
      isOrcaHookTrusted(trust, args.repos, trustRepoId, 'archive', archiveTrust.contentHash)
    ) {
      return { kind: 'run' }
    }
    return {
      kind: 'ask',
      trust,
      repos: args.repos,
      prompt: {
        kind: 'archive',
        repoId: trustRepoId,
        repoName: args.item.repo,
        scriptContent: archiveTrust.scriptContent,
        contentHash: archiveTrust.contentHash,
        previouslyApproved: wasOrcaHookPreviouslyApproved(trust, trustRepoId, 'archive'),
        versionOnly: usesVersionedOrcaHookTrust(args.repos, trustRepoId)
      }
    }
  } catch {
    return { kind: 'skip' }
  }
}
