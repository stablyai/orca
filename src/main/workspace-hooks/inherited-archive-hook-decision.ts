import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import {
  getRepoDialableSshTargetId,
  isRepoOnCatalogHost
} from '../../shared/execution-host/execution-host'
import { scopeHooksToRepoKind } from '../../shared/folder-workspaces/folder-workspace-hooks'
import { listEnvironments } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { isFolderRepo } from '../../shared/repository/repo-kind'
import { resolveHookCommandSourcePolicy } from '../../shared/workspace-setup/hooks/hook-command-source-policy'
import { isOrcaHookTrusted } from '../../shared/workspace-setup/hooks/orca-hook-trust-entries'
import type { WorkspaceHookOwner } from '../../shared/workspace-setup/hooks/workspace-hook-owner'
import type {
  OrcaHooks,
  PersistedTrustedOrcaHooks
} from '../../shared/workspace-setup/orca-yaml-hook-types'
import {
  requestedArchiveHookDecision,
  type ArchiveHookChoice,
  type ArchiveHookDecision
} from '../../shared/worktree/removal/archive-hook-decision'
import { hashOrcaHookTrustContent } from './created-worktree-setup-trust'
import { getEffectiveHooks, hasHooksFile, loadHooks } from './hooks'

/** As the desktop's archive prompt: only a shared orca.yaml script needs trust; null means none does. */
export function archiveTrust(
  repo: WorkspaceHookOwner,
  sharedHooks: OrcaHooks | null
): { contentHash: string; scriptContent: string } | null {
  const localArchive = repo.hookSettings?.scripts.archive?.trim()
  const policy = resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(localArchive)
  })
  const sharedArchive = sharedHooks?.scripts.archive?.trim()
  return policy === 'local-only' || !sharedArchive
    ? null
    : { contentHash: hashOrcaHookTrustContent(sharedArchive), scriptContent: sharedArchive }
}

export type ArchiveHookTrustContext = {
  trust: PersistedTrustedOrcaHooks | undefined
  repos: readonly { id: string }[]
  /** A project group's trust key already names its host, so no other host can share it. */
  hostQualifiedId?: boolean
}

/** `inherit` runs the hook only when the desktop's Delete would run it without asking. */
export async function decideArchiveHook(
  choice: ArchiveHookChoice,
  owner: WorkspaceHookOwner | undefined,
  context: () => ArchiveHookTrustContext
): Promise<ArchiveHookDecision> {
  if (choice !== 'inherit') {
    return requestedArchiveHookDecision(choice)
  }
  // An SSH or other-host owner's orca.yaml can't be read here to compare against approvals.
  if (
    !owner ||
    getRepoDialableSshTargetId(owner) ||
    (isFolderRepo(owner) && !isRepoOnCatalogHost(owner))
  ) {
    return { decision: 'skip', reason: 'unverifiable' }
  }
  if (!getEffectiveHooks(owner)?.scripts.archive) {
    return { decision: 'skip', reason: 'none' }
  }
  const shared = archiveTrust(
    owner,
    scopeHooksToRepoKind(owner, hasHooksFile(owner.path) ? loadHooks(owner.path) : null)
  )
  if (!shared) {
    return { decision: 'run', reason: 'approved' }
  }
  const { trust, repos, hostQualifiedId } = context()
  return isOrcaHookTrusted(
    trust ?? {},
    !hostQualifiedId && (await mayHoldRepoIdElsewhere()) ? null : repos,
    owner.id,
    'archive',
    shared.contentHash
  )
    ? { decision: 'run', reason: 'approved' }
    : { decision: 'skip', reason: 'not-approved' }
}

// Repo-wide trust needs a unique repo id; paired servers' repos aren't in this catalog, so only version approvals count then.
async function mayHoldRepoIdElsewhere(): Promise<boolean> {
  try {
    return (await listEnvironments(getAppEnvironment().getPath('userData'))).length > 0
  } catch {
    return true
  }
}
