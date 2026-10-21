import type { ExecutionHostId } from '../../shared/execution-host'
import { normalizeGitRemoteUrl } from '../../shared/git-remote-identity'
import { isShowRefNoMatchError } from '../../shared/git-show-ref-no-match'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { runGitProbeOnHost } from '../repo-git-remote-identity'

type GitProbe = (args: string[]) => Promise<string>

/** Read failures stay distinct from Git proving an unborn HEAD. */
function probeIn(repoPath: string, hostId: ExecutionHostId, signal?: AbortSignal): GitProbe {
  return async (args) => {
    if (signal?.aborted) {
      throw new Error('Clone aborted')
    }
    const result = await runGitProbeOnHost(args, repoPath, hostId, { signal })
    if (!result) {
      throw new Error('Clone target host is unavailable')
    }
    return result.stdout
  }
}

/** Only an empty first line means the folder is the checkout's own top level: a subfolder prints
 *  `../`, and a bare repo prints nothing so whatever follows lands on the first line instead. */
function isCheckoutTopLevel(cdupStdout: string | null): boolean {
  return cdupStdout !== null && cdupStdout.split(/\r?\n/)[0] === ''
}

/** True when git shows `repoPath` is a checkout's own top level whose HEAD git finished writing. */
async function isFinishedCheckout(
  probe: GitProbe
): Promise<{ unbornBranch: string | null } | null> {
  try {
    const settled = await probe(['rev-parse', '--show-cdup', '--verify', '--quiet', 'HEAD'])
    return isCheckoutTopLevel(settled) ? { unbornBranch: null } : null
  } catch (error) {
    // The same quiet missing-ref exit applies to rev-parse; transport faults must stop here.
    if (!isShowRefNoMatchError(error)) {
      throw error
    }
  }
  if (!isCheckoutTopLevel(await probe(['rev-parse', '--show-cdup']))) {
    return null
  }
  const head = (await probe(['symbolic-ref', 'HEAD'])).trim()
  return head.startsWith('refs/heads/') ? { unbornBranch: head.slice('refs/heads/'.length) } : null
}

async function readCloneOrigin(
  probe: GitProbe,
  unbornBranch: string | null
): Promise<string | null> {
  if (unbornBranch === null) {
    return (await probe(['config', '--get-all', 'remote.origin.url'])).trim()
  }
  const branchKey = `branch.${unbornBranch}`
  const escapedKey = branchKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const config = await probe([
    'config',
    '--get-regexp',
    `^(remote\\.origin\\.url|${escapedKey}\\.(remote|merge))$`
  ])
  const values = new Map<string, string>()
  for (const line of config.trim().split('\n')) {
    const separator = line.indexOf(' ')
    if (separator === -1) {
      return null
    }
    const key = line.slice(0, separator)
    if (values.has(key)) {
      return null
    }
    values.set(key, line.slice(separator + 1))
  }
  // Git 2.25 writes this tracking pair only after an empty clone is known to have finished.
  if (
    values.get(`${branchKey}.remote`) !== 'origin' ||
    values.get(`${branchKey}.merge`) !== `refs/heads/${unbornBranch}`
  ) {
    return null
  }
  return values.get('remote.origin.url') ?? null
}

/** True only when git on `hostId` shows `repoPath` is a finished checkout whose single origin URL
 *  names the same repo as `url` — what a finished `git clone url` leaves. */
async function isFinishedCloneOf(
  repoPath: string,
  url: string,
  hostId: ExecutionHostId,
  signal?: AbortSignal
): Promise<boolean> {
  const probe = probeIn(repoPath, hostId, signal)
  try {
    const checkout = await isFinishedCheckout(probe)
    if (!checkout) {
      return false
    }
    const originUrl = await readCloneOrigin(probe, checkout.unbornBranch)
    if (!originUrl || originUrl.includes('\n')) {
      return false
    }
    const requestedKey = normalizeGitRemoteUrl(url)
    return requestedKey ? normalizeGitRemoteUrl(originUrl) === requestedKey : originUrl === url
  } catch {
    return false
  }
}

/**
 * Decides what a clone does about a saved project already at its path. Returns the project when its
 * folder is already a clone of `url`, null when git should clone (nothing saved, or the saved
 * project was this repo and lost its folder), and throws when the saved project is something else.
 * `findSaved` must match path and host, so re-reading it after the probe also checks the host.
 */
export async function reuseSavedCloneTarget(
  findSaved: () => Repo | undefined,
  url: string,
  hostId: ExecutionHostId,
  signal?: AbortSignal
): Promise<Repo | null> {
  const saved = findSaved()
  if (!saved || isFolderRepo(saved)) {
    return null
  }
  const isClone = await isFinishedCloneOf(saved.path, url, hostId, signal)
  if (signal?.aborted) {
    throw new Error('Clone aborted')
  }
  if (isClone) {
    const current = findSaved()
    // Why: removed or replaced while git answered; git clone then refuses the non-empty folder.
    return current?.id === saved.id ? current : null
  }
  const requestedKey = normalizeGitRemoteUrl(url)
  // Why: `origin` is the only stored remote that names the project's own repo. `upstream` names the
  // repo a fork came from, and so do `Repo.upstream` and the GitHub avatar `repoIcon` derived from it.
  const storedOrigin =
    saved.gitRemoteIdentity?.remoteName === 'origin' ? saved.gitRemoteIdentity : null
  // Why: the project was this repo, so its settings still belong once git re-creates the folder.
  if (requestedKey && storedOrigin?.canonicalKey === requestedKey) {
    return null
  }
  throw new Error(
    `"${saved.displayName}" is already an Orca project at ${saved.path}, and Orca couldn't confirm that folder is a clone of this URL: ${
      storedOrigin
        ? 'Orca has that project recorded as a different repository'
        : 'Orca has no record of which repository that project holds, so it cannot tell whether the folder is missing or holds something else'
    }. Remove the project from Orca or choose another folder.`
  )
}
