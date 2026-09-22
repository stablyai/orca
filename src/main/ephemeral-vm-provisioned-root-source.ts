import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { gitExecFileAsync } from './git/runner'
import { resolveDefaultBaseRefWithLocalGit } from './git/repo'
import { getLocalProjectGitExecOptions } from './project-runtime-git-options'
import { resolveWorktreeCreateBase } from './worktree-create-base'
import { resolveWorktreeAddBaseRef } from '../shared/worktree/base-ref'

const PROVISIONED_ROOT_SOURCE_REF_TIMEOUT_MS = 15_000

export async function resolveProvisionedRootSource(
  store: Store,
  repo: Repo,
  requestedRef?: string,
  signal?: AbortSignal
): Promise<{ ref: string; head: string; remoteUrl?: string } | null> {
  const gitOptions = {
    ...getLocalProjectGitExecOptions(store, repo),
    ...(signal ? { signal } : {})
  }
  const resolveHead = async (ref: string): Promise<string | null> => {
    try {
      const { stdout } = await gitExecFileAsync(
        ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
        { ...gitOptions, timeout: PROVISIONED_ROOT_SOURCE_REF_TIMEOUT_MS }
      )
      return stdout.trim() || null
    } catch {
      return null
    }
  }
  const ref = await resolveWorktreeCreateBase({
    requestedBaseBranch: requestedRef?.trim() || undefined,
    repoWorktreeBaseRef: repo.worktreeBaseRef,
    resolveDefaultBaseRef: () => resolveDefaultBaseRefWithLocalGit(gitOptions),
    isBaseUsable: async (candidate) => Boolean(await resolveHead(candidate))
  })
  if (!ref) {
    return null
  }
  const head = await resolveHead(ref)
  if (!head) {
    return null
  }
  const remoteSource = await resolveRemoteSource(ref, resolveHead, gitOptions)
  return remoteSource ? { ...remoteSource, head } : { ref, head }
}

async function resolveRemoteSource(
  ref: string,
  resolveHead: (ref: string) => Promise<string | null>,
  gitOptions: { cwd: string; wslDistro?: string; signal?: AbortSignal }
): Promise<{ ref: string; remoteUrl: string } | null> {
  const qualified = await resolveWorktreeAddBaseRef(ref, async (candidate) =>
    Boolean(await resolveHead(candidate))
  )
  const prefix = 'refs/remotes/'
  if (!qualified.startsWith(prefix)) {
    return null
  }
  try {
    const { stdout } = await gitExecFileAsync(['remote'], {
      ...gitOptions,
      timeout: PROVISIONED_ROOT_SOURCE_REF_TIMEOUT_MS
    })
    const shortRef = qualified.slice(prefix.length)
    const remote = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => shortRef.startsWith(`${entry}/`))
      .sort((left, right) => right.length - left.length)[0]
    const branch = remote ? shortRef.slice(remote.length + 1) : ''
    if (!remote || !branch) {
      return null
    }
    const { stdout: remoteUrl } = await gitExecFileAsync(['remote', 'get-url', remote], {
      ...gitOptions,
      timeout: PROVISIONED_ROOT_SOURCE_REF_TIMEOUT_MS
    })
    return remoteUrl.trim() ? { ref: `refs/heads/${branch}`, remoteUrl: remoteUrl.trim() } : null
  } catch {
    return null
  }
}
