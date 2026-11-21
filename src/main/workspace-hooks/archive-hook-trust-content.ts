import {
  getRepoDialableSshTargetId,
  isRepoOnCatalogHost
} from '../../shared/execution-host/execution-host'
import { scopeHooksToRepoKind } from '../../shared/folder-workspaces/folder-workspace-hooks'
import { resolveHookCommandSourcePolicy } from '../../shared/workspace-setup/hooks/hook-command-source-policy'
import type { WorkspaceHookOwner } from '../../shared/workspace-setup/hooks/workspace-hook-owner'
import type { OrcaHooks } from '../../shared/workspace-setup/orca-yaml-hook-types'
import { ARCHIVE_HOOK_CHANGED_CODE } from '../../shared/worktree/removal/archive-hook-decision'
import { hashOrcaHookTrustContent } from './created-worktree-setup-trust'
import { getEffectiveHooksFromConfig } from './effective-hook-config'
import { readFile } from 'node:fs/promises'
import { parseOrcaYaml } from '../../shared/workspace-setup/orca-yaml'
import { orcaYamlPath } from './hooks'

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

export class ArchiveHookChangedError extends Error {
  readonly code = ARCHIVE_HOOK_CHANGED_CODE
  constructor(path: string) {
    super(
      `The orca.yaml archive hook in ${path} changed after it was approved. Nothing was deleted. Approve it in Orca, or pass --archive run or --archive skip.`
    )
  }
}

/** orca.yaml's hooks, or null when missing or unreadable; reads without blocking main. */
export async function readOrcaYamlHooks(repoPath: string): Promise<OrcaHooks | null> {
  try {
    return parseOrcaYaml(await readFile(orcaYamlPath(repoPath), 'utf-8'))
  } catch {
    return null
  }
}

/** Hash of the script that needs trust, or of '' when none does, so an added script is caught too. */
export function archiveTrustHash(owner: WorkspaceHookOwner, yamlHooks: OrcaHooks | null): string {
  const trust = archiveTrust(owner, scopeHooksToRepoKind(owner, yamlHooks))
  return trust?.contentHash ?? hashOrcaHookTrustContent('')
}

/**
 * Reads orca.yaml once for a removal. A pinned approval is checked against that same read, which
 * the caller then runs, so a script changed while the delete waited in a queue is refused.
 */
export async function loadArchiveHooksForRemoval(
  owner: WorkspaceHookOwner,
  request: { runHooks?: boolean; approvedArchiveHash?: string }
): Promise<OrcaHooks | null> {
  const yamlHooks = await readOrcaYamlHooks(owner.path)
  if (
    request.runHooks === true &&
    request.approvedArchiveHash !== undefined &&
    // Only the host holding the files can read them; elsewhere the runner on that host decides.
    !getRepoDialableSshTargetId(owner) &&
    isRepoOnCatalogHost(owner) &&
    archiveTrustHash(owner, yamlHooks) !== request.approvedArchiveHash
  ) {
    throw new ArchiveHookChangedError(owner.path)
  }
  return getEffectiveHooksFromConfig(owner, yamlHooks)
}
