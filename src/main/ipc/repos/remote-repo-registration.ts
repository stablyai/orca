import { randomUUID } from 'node:crypto'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../shared/constants'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { getRepoSshConnectionId, toSshExecutionHostId } from '../../../shared/execution-host'
import { getSshGitProvider } from '../../providers/ssh-git-dispatch'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { getActiveMultiplexer } from '../../ssh/ssh-target-registry'
import { resolveRemoteHomePath } from './remote-home-path'

export async function addRemoteRepoFromPath(
  store: Store,
  args: {
    connectionId: string
    remotePath: string
    displayName?: string
    kind?: 'git' | 'folder'
    setupMethod?: Repo['projectHostSetupMethod']
  }
): Promise<{ repo: Repo; alreadyExisted: boolean } | { error: string }> {
  const gitProvider = getSshGitProvider(args.connectionId)
  if (!gitProvider) {
    return { error: `SSH connection "${args.connectionId}" not found or not connected` }
  }

  let repoKind: 'git' | 'folder' = args.kind ?? 'git'
  let resolvedPath = await resolveRemoteHomePath(args.connectionId, args.remotePath)

  // Resolve the host: a row stamped only `executionHostId: 'ssh:*'` is the same registration, and
  // missing it here registers a duplicate repo for a path the host already owns.
  const existing = store
    .getRepos()
    .find(
      (repo) =>
        getRepoSshConnectionId(repo) === args.connectionId &&
        normalizeRuntimePathForComparison(repo.path) ===
          normalizeRuntimePathForComparison(resolvedPath)
    )
  if (existing) {
    return { repo: existing, alreadyExisted: true }
  }

  if (args.kind !== 'folder') {
    try {
      const check = await gitProvider.isGitRepoAsync(resolvedPath)
      if (check.isRepo) {
        repoKind = 'git'
        if (check.rootPath) {
          resolvedPath = check.rootPath
        }
      } else {
        return { error: `Not a valid git repository: ${args.remotePath}` }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Not a valid git repository')) {
        return { error: err.message }
      }
      return { error: `Not a valid git repository: ${args.remotePath}` }
    }
  }

  const existingAfterRootResolve = store
    .getRepos()
    .find(
      (repo) =>
        getRepoSshConnectionId(repo) === args.connectionId &&
        normalizeRuntimePathForComparison(repo.path) ===
          normalizeRuntimePathForComparison(resolvedPath)
    )
  if (existingAfterRootResolve) {
    return { repo: existingAfterRootResolve, alreadyExisted: true }
  }

  const folderName = getRemoteRepoFolderName(resolvedPath)
  let displayName = args.displayName || folderName
  if (!args.displayName && (args.remotePath === '~' || args.remotePath === '~/')) {
    const sshTarget = store.getSshTarget(args.connectionId)
    if (sshTarget) {
      displayName = sshTarget.label
    }
  }

  const detected = await detectRepoIconAndUpstream({
    repoPath: resolvedPath,
    kind: repoKind,
    executionHostId: toSshExecutionHostId(args.connectionId)
  })
  const repo: Repo = {
    id: randomUUID(),
    path: resolvedPath,
    displayName,
    badgeColor: DEFAULT_REPO_BADGE_COLOR,
    ...detected,
    addedAt: Date.now(),
    kind: repoKind,
    connectionId: args.connectionId,
    // Stamp the unified spelling at creation: this is now the runtime's SSH registration path too,
    // and minting `connectionId`-only rows leaves every host-resolving reader on the legacy field.
    executionHostId: toSshExecutionHostId(args.connectionId),
    ...(repoKind === 'git'
      ? {
          externalWorktreeVisibilityLegacy: false,
          projectHostSetupMethod: args.setupMethod ?? ('imported-existing-folder' as const)
        }
      : {})
  }

  store.addRepo(repo)
  const mux = getActiveMultiplexer(args.connectionId)
  if (mux) {
    mux.notify('session.registerRoot', { rootPath: resolvedPath })
  }

  return { repo, alreadyExisted: false }
}

function getRemoteRepoFolderName(remotePath: string): string {
  const trimmed = remotePath.replace(/[\\/]+$/, '')
  if (!trimmed) {
    return remotePath
  }
  return trimmed.split(/[\\/]/).at(-1) || remotePath
}
