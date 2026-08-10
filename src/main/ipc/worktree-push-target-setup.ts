// Why: preparing a fork-PR push target means adding (or reusing) the contributor's
// fork as a git remote, fetching the head, and wiring the new branch's upstream.
// The git-driven core lives here behind an injectable `execGit` seam so the
// remote-reuse / unique-naming / fetch behavior is unit-testable without a real
// repo. The store-aware ownership decision stays with the caller via a predicate.

import type { GitPushTarget } from '../../shared/types'
import { parseGitHubOwnerRepo } from '../github/gh-utils'
import type { GitRemoteExec } from './worktree-push-target-cleanup'

const pushTargetPreparationTails = new Map<string, Promise<void>>()

type WorktreePushTargetPreparationLeaseOptions = {
  remainingTimeoutMs?: () => number
  signal?: AbortSignal
}

function pushTargetPreparationKey(repoPath: string, target: GitPushTarget): string | null {
  if (!target.remoteUrl) {
    return null
  }
  const parsed = parseGitHubOwnerRepo(target.remoteUrl)
  const remoteKey = parsed
    ? `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`
    : target.remoteUrl
  return `${repoPath}\0${remoteKey}`
}

function remoteUrlsMatch(leftUrl: string, rightUrl: string): boolean {
  const left = parseGitHubOwnerRepo(leftUrl)
  const right = parseGitHubOwnerRepo(rightUrl)
  return left && right
    ? left.owner.toLowerCase() === right.owner.toLowerCase() &&
        left.repo.toLowerCase() === right.repo.toLowerCase()
    : leftUrl === rightUrl
}

function mayHaveCompletedRemoteAdd(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as Error & { code?: unknown }).code
  return (
    error.name === 'AbortError' ||
    error.message.toLowerCase().includes('timed out') ||
    code === 'ETIMEDOUT' ||
    code === 'CONNECTION_LOST' ||
    code === 'SSH_MUX_REQUEST_TIMEOUT'
  )
}

async function waitForPushTargetPreparationTurn(
  previous: Promise<void>,
  options: WorktreePushTargetPreparationLeaseOptions
): Promise<void> {
  const { remainingTimeoutMs, signal } = options
  if (!remainingTimeoutMs && !signal) {
    await previous.catch(() => {})
    return
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
      }
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    }
    const onAbort = (): void =>
      finish(Object.assign(new Error('Worktree creation was cancelled.'), { name: 'AbortError' }))
    const armDeadline = (): void => {
      if (!remainingTimeoutMs || settled) {
        return
      }
      try {
        const remaining = remainingTimeoutMs()
        if (remaining <= 0) {
          finish(new Error('Worktree push-target preparation timed out.'))
          return
        }
        timer = setTimeout(armDeadline, remaining)
        timer.unref?.()
      } catch (error) {
        finish(error)
      }
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    void previous.catch(() => {}).then(() => finish())
    armDeadline()
  })
}

export async function acquireWorktreePushTargetPreparationLease(
  repoPath: string,
  target: GitPushTarget,
  options: WorktreePushTargetPreparationLeaseOptions = {}
): Promise<() => void> {
  const key = pushTargetPreparationKey(repoPath, target)
  if (!key) {
    return () => {}
  }
  const previous = pushTargetPreparationTails.get(key) ?? Promise.resolve()
  let releaseSlot!: () => void
  const slot = new Promise<void>((resolve) => {
    releaseSlot = resolve
  })
  const tail = previous.catch(() => {}).then(() => slot)
  pushTargetPreparationTails.set(key, tail)

  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    releaseSlot()
    void tail.finally(() => {
      if (pushTargetPreparationTails.get(key) === tail) {
        pushTargetPreparationTails.delete(key)
      }
    })
  }
  try {
    await waitForPushTargetPreparationTurn(previous, options)
  } catch (error) {
    release()
    throw error
  }
  return release
}

export async function findRemoteForUrl(
  execGit: GitRemoteExec,
  repoPath: string,
  remoteUrl: string
): Promise<string | null> {
  const target = parseGitHubOwnerRepo(remoteUrl)
  try {
    const { stdout } = await execGit(['remote'], repoPath)
    for (const remote of stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)) {
      try {
        const { stdout: urlStdout } = await execGit(['remote', 'get-url', remote], repoPath)
        const candidateUrl = urlStdout.trim()
        if (
          (target && remoteUrlsMatch(candidateUrl, remoteUrl)) ||
          (!target && candidateUrl === remoteUrl)
        ) {
          return remote
        }
      } catch {
        // Ignore a remote that disappeared or has no fetch URL.
      }
    }
  } catch {
    return null
  }
  return null
}

export async function ensureUniqueRemoteName(
  execGit: GitRemoteExec,
  repoPath: string,
  preferred: string
): Promise<string> {
  const { stdout } = await execGit(['remote'], repoPath)
  const existing = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  )
  if (!existing.has(preferred)) {
    return preferred
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${preferred}-${suffix}`
    if (!existing.has(candidate)) {
      return candidate
    }
  }
  throw new Error(`Could not find an available remote name for ${preferred}.`)
}

// Exported for unit tests: the `execGit` seam drives the remote add/reuse/fetch
// behavior without a real repo. `isRemoteCreatedByKnownWorktree` lets the caller
// inject the store-aware ownership decision for the reuse case.
export async function prepareWorktreePushTargetWithExec(
  execGit: GitRemoteExec,
  repoPath: string,
  target: GitPushTarget,
  isRemoteCreatedByKnownWorktree: (existingRemote: string) => boolean,
  cleanupExecGit: GitRemoteExec = execGit,
  fetchRemoteTrackingRef?: (remoteName: string) => Promise<void>
): Promise<GitPushTarget> {
  const { remoteCreated: _ignoredRemoteCreated, ...sanitizedTarget } = target
  let remoteName = target.remoteName
  let remoteCreated = false
  let createdThisCall = false
  if (target.remoteUrl) {
    const existingRemote = await findRemoteForUrl(execGit, repoPath, target.remoteUrl)
    if (existingRemote) {
      remoteName = existingRemote
      // Why: if a later PR worktree reuses an Orca-created fork remote, it
      // must inherit ownership so deleting the final user can remove it.
      remoteCreated = isRemoteCreatedByKnownWorktree(existingRemote)
    } else {
      remoteName = await ensureUniqueRemoteName(execGit, repoPath, target.remoteName)
      try {
        await execGit(['remote', 'add', remoteName, target.remoteUrl], repoPath)
      } catch (error) {
        if (mayHaveCompletedRemoteAdd(error)) {
          try {
            const { stdout } = await cleanupExecGit(['remote', 'get-url', remoteName], repoPath)
            if (remoteUrlsMatch(stdout.trim(), target.remoteUrl)) {
              await cleanupExecGit(['remote', 'remove', remoteName], repoPath)
            }
          } catch {
            // Preserve the mutation failure; retries can reconcile any surviving remote.
          }
        }
        throw error
      }
      remoteCreated = true
      createdThisCall = true
    }
  }

  try {
    await (fetchRemoteTrackingRef
      ? fetchRemoteTrackingRef(remoteName)
      : execGit(
          [
            'fetch',
            remoteName,
            `+refs/heads/${target.branchName}:refs/remotes/${remoteName}/${target.branchName}`
          ],
          repoPath
        ))
  } catch (error) {
    if (createdThisCall) {
      try {
        await cleanupExecGit(['remote', 'remove', remoteName], repoPath)
      } catch {
        // Keep the fetch failure actionable; later retries can reuse or disambiguate the remote.
      }
    }
    throw error
  }
  return {
    ...sanitizedTarget,
    remoteName,
    ...(remoteCreated ? { remoteCreated: true } : {})
  }
}

export async function configureCreatedWorktreePushTargetWithExec(
  execGit: GitRemoteExec,
  worktreePath: string,
  branchName: string,
  target: GitPushTarget
): Promise<GitPushTarget> {
  await execGit(
    ['branch', '--set-upstream-to', `${target.remoteName}/${target.branchName}`, branchName],
    worktreePath
  )
  return target
}
