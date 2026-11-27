import { lstat } from 'node:fs/promises'
import type { WorkspaceHookOwner } from '../../shared/workspace-setup/hooks/workspace-hook-owner'
import type { OrcaHooks } from '../../shared/workspace-setup/orca-yaml-hook-types'
import { parseOrcaYaml } from '../../shared/workspace-setup/orca-yaml'
import { MAX_ORCA_YAML_BYTES } from '../../shared/workspace-setup/orca-yaml-file-limit'
import { readNodeFileWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import { resolveHookCommandSourcePolicy } from '../../shared/workspace-setup/hooks/hook-command-source-policy'
import { getEffectiveHooksFromConfig } from './effective-hook-config'
import { hashOrcaHookTrustContent } from './created-worktree-setup-trust'
import { orcaYamlPath } from './hooks'
import { canSafelyRemoveOrphanedWorktreeDirectory } from '../workspaces/removal/worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from '../workspaces/removal/worktree-removal-home-guard'
import {
  readCheckoutMarkerState,
  readCheckoutRootState
} from '../workspaces/removal/worktree-removal-gitdir-identity'
import { getLocalWorktreePathAccess } from '../workspaces/removal/local-worktree-filesystem'
import type { LocalProjectWorktreeGitOptions } from '../workspaces/execution-host/project-runtime-git-options'

async function readArchiveConfig(root: string): Promise<{ hooks: OrcaHooks | null } | null> {
  const path = orcaYamlPath(root)
  try {
    await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  // A dangling link or a file lost after lstat is not permission to switch sources.
  const { buffer } = await readNodeFileWithinLimit(path, MAX_ORCA_YAML_BYTES, {
    regularFileOnly: true
  })
  return { hooks: parseOrcaYaml(buffer.toString('utf8'), { rejectInvalidDocument: true }) }
}

/** The caller must resolve this checkout on its owning host before inspecting or running it. */
export async function readWorktreeArchiveHooks(
  repo: WorkspaceHookOwner,
  worktreePath: string,
  gitOptions: LocalProjectWorktreeGitOptions = {}
) {
  const policy = resolveHookCommandSourcePolicy(repo.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(repo.hookSettings?.scripts.archive?.trim())
  })
  let sourcePath = repo.path
  let checkoutIdentity: string | undefined
  let yamlHooks: OrcaHooks | null = null
  if (policy !== 'local-only') {
    const root = await readArchiveConfig(repo.path)
    if (root) {
      yamlHooks = root.hooks
    } else {
      sourcePath = worktreePath
      const rootState = await readCheckoutRootState(worktreePath, gitOptions)
      if (rootState.kind !== 'absent') {
        const marker = await readCheckoutMarkerState(worktreePath, gitOptions)
        if (
          rootState.kind !== 'directory' ||
          marker.kind !== 'file' ||
          !(await canSafelyRemoveOrphanedWorktreeDirectory(
            worktreePath,
            repo.path,
            CLIENT_REMOVAL_HOME,
            getLocalWorktreePathAccess(gitOptions, worktreePath)
          ))
        ) {
          throw new Error('Cannot verify the checkout owner before reading its Archive hook.')
        }
        yamlHooks = (await readArchiveConfig(worktreePath))?.hooks ?? null
        const after = await readCheckoutMarkerState(worktreePath, gitOptions)
        if (after.kind !== 'file' || after.identity !== marker.identity) {
          throw new Error('Checkout changed while reading its Archive hook. Retry deletion.')
        }
        checkoutIdentity = marker.identity
      }
    }
  }
  const hooks = getEffectiveHooksFromConfig(repo, yamlHooks)
  const archive = hooks?.scripts.archive ?? ''
  return {
    hooks,
    sharedArchive: policy === 'local-only' ? '' : (yamlHooks?.scripts.archive ?? ''),
    sourcePath,
    checkoutSource: sourcePath !== repo.path,
    approvalHash: hashOrcaHookTrustContent(
      JSON.stringify([
        repo.path,
        sourcePath === repo.path ? undefined : worktreePath,
        sourcePath,
        checkoutIdentity,
        policy,
        archive
      ])
    )
  }
}

export async function loadWorktreeArchiveHooksForRemoval(
  repo: WorkspaceHookOwner,
  worktreePath: string,
  approvedArchiveHash?: string,
  gitOptions: LocalProjectWorktreeGitOptions = {}
): Promise<OrcaHooks | null> {
  const resolved = await readWorktreeArchiveHooks(repo, worktreePath, gitOptions)
  if (
    (approvedArchiveHash !== undefined && approvedArchiveHash !== resolved.approvalHash) ||
    (approvedArchiveHash === undefined &&
      resolved.checkoutSource &&
      resolved.hooks?.scripts.archive)
  ) {
    throw new Error(
      `Archive approval required for ${orcaYamlPath(resolved.sourcePath)}. ` +
        'The archive script or its source was not approved for this checkout, or changed after approval. ' +
        'Open the checkout on its owning desktop to review it, or review and save the Archive command in this project’s local settings before retrying.'
    )
  }
  return resolved.hooks
}
