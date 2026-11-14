import type { Repo } from '../../shared/repo-types'
import type { OrcaHooks } from '../../shared/orca-yaml-hook-types'
import { parseOrcaYaml } from '../../shared/orca-yaml'
import { scopeHooksToRepoKind } from '../../shared/folder-workspace-hooks'
import { isFolderRepo } from '../../shared/repo-kind'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-refs/base-ref'
import type { SetupHooksCreateSource } from '../../shared/worktree/setup-hooks-create-source'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import {
  getDefaultBaseRefAsync,
  type LocalGitExecOptions
} from '../git/refs/resolution/repo-default-base-ref'
import {
  hasLocalWorktreeBaseRef,
  hasWorktreeBaseCommitRef
} from '../git/worktrees/creation/worktree-base-ref-probe'
import { resolveWorktreeCreateBase } from '../workspaces/creation/worktree-create-base'
import type {
  RemoteFetchResult,
  RemoteTrackingBase
} from '../runtime/repositories/runtime-remote-fetch-controller'

// Leaves the 15 s hooks-check RPC room to fall back to the checkout read.
const CREATE_SOURCE_READ_DEADLINE_MS = 8_000

export type CreateSourceSetupHooksRuntime = {
  resolveRemoteTrackingBase: (
    repoPath: string,
    baseBranch: string,
    options?: LocalGitExecOptions
  ) => Promise<RemoteTrackingBase | null>
  hasRemoteTrackingRef: (
    repoPath: string,
    base: RemoteTrackingBase,
    options?: LocalGitExecOptions
  ) => Promise<boolean>
  getOrStartRemoteTrackingBaseRefresh: (
    repoPath: string,
    base: RemoteTrackingBase,
    options?: LocalGitExecOptions
  ) => Promise<RemoteFetchResult>
}

class DeadlinePassed extends Error {}

/**
 * The orca.yaml hooks at the ref a create will check out. Undefined when that ref can't be read in
 * time; callers then read the project checkout, as before, and the host's created-worktree check stays the backstop.
 */
export async function readCreateSourceSetupHooks(args: {
  repo: Repo
  source: SetupHooksCreateSource
  runtime: CreateSourceSetupHooksRuntime
  gitOptions: LocalGitExecOptions
}): Promise<{ hooks: OrcaHooks | null } | undefined> {
  if (isFolderRepo(args.repo)) {
    return undefined
  }
  const deadline = Date.now() + CREATE_SOURCE_READ_DEADLINE_MS
  // Git admission refuses past the deadline, even for a step the race already abandoned.
  const gated = { ...args.gitOptions, canStart: () => Date.now() < deadline }
  const step = async <T>(work: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new DeadlinePassed()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DeadlinePassed()), remaining)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const ref = await step(() => resolveCreateSourceRef(args, gated, step))
    return ref ? await step(() => readOrcaYamlAtRef(args.repo, ref, gated)) : undefined
  } catch {
    return undefined
  }
}

async function resolveCreateSourceRef(
  args: Parameters<typeof readCreateSourceSetupHooks>[0],
  gitOptions: LocalGitExecOptions,
  step: <T>(work: () => Promise<T>) => Promise<T>
): Promise<string | null> {
  const { repo, source, runtime } = args
  // Explicit reuse checks out exactly the local branch when it exists, otherwise creates it from the base.
  if (source.kind === 'branch') {
    const localRef = `refs/heads/${source.ref}`
    if (await step(() => hasWorktreeBaseCommitRef(repo.path, localRef, gitOptions))) {
      return localRef
    }
  }
  const baseBranch = await step(() =>
    resolveWorktreeCreateBase({
      requestedBaseBranch: source.baseBranch,
      repoWorktreeBaseRef: repo.worktreeBaseRef,
      resolveDefaultBaseRef: () => getDefaultBaseRefAsync(repo.path, gitOptions),
      isBaseUsable: async (candidate) => {
        const remoteBase = await runtime.resolveRemoteTrackingBase(repo.path, candidate, gitOptions)
        if (remoteBase && (await runtime.hasRemoteTrackingRef(repo.path, remoteBase, gitOptions))) {
          return true
        }
        return hasLocalWorktreeBaseRef(repo.path, candidate, gitOptions)
      }
    })
  )
  if (!baseBranch) {
    return null
  }
  // Refresh exactly when create would, sharing its in-flight fetch and freshness.
  const remoteBase = await step(() =>
    runtime.resolveRemoteTrackingBase(repo.path, baseBranch, gitOptions)
  )
  if (remoteBase) {
    const [hasRemoteRef, hasLocalRef] = await step(() =>
      Promise.all([
        runtime.hasRemoteTrackingRef(repo.path, remoteBase, gitOptions),
        hasLocalWorktreeBaseRef(repo.path, baseBranch, gitOptions)
      ])
    )
    if (hasRemoteRef || !hasLocalRef) {
      // Ungated and never aborted: past the deadline create joins this same fetch.
      await step(() =>
        runtime.getOrStartRemoteTrackingBaseRefresh(repo.path, remoteBase, args.gitOptions)
      )
    }
  }
  const qualified = await step(() =>
    resolveWorktreeAddBaseRef(baseBranch, (candidate) =>
      hasWorktreeBaseCommitRef(repo.path, candidate, gitOptions)
    )
  )
  return (await step(() => hasWorktreeBaseCommitRef(repo.path, qualified, gitOptions)))
    ? qualified
    : null
}

async function readOrcaYamlAtRef(
  repo: Repo,
  ref: string,
  gitOptions: LocalGitExecOptions
): Promise<{ hooks: OrcaHooks | null } | undefined> {
  const { stdout: entry } = await gitExecFileAsync(['ls-tree', ref, '--', 'orca.yaml'], {
    cwd: repo.path,
    ...gitOptions
  })
  if (!entry.trim()) {
    return { hooks: null }
  }
  // A symlink's blob is its target path; the checkout follows it, so read the checkout instead.
  if (!entry.startsWith('100')) {
    return undefined
  }
  const { stdout } = await gitExecFileAsync(['show', `${ref}:orca.yaml`], {
    cwd: repo.path,
    ...gitOptions
  })
  return { hooks: scopeHooksToRepoKind(repo, parseOrcaYaml(stdout)) }
}
