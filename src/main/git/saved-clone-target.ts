import type { ExecutionHostId } from '../../shared/execution-host'
import { normalizeGitRemoteUrl } from '../../shared/git-remote-identity'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { runGitProbeOnHost } from '../repo-git-remote-identity'

type GitProbe = (args: string[]) => Promise<string | null>

/** Runs read-only git commands in the saved folder, folding "git failed" and "no route to that
 *  host's git" into null so neither can read as a positive answer. */
function probeIn(repoPath: string, hostId: ExecutionHostId, signal?: AbortSignal): GitProbe {
  return async (args) => {
    // Why: once Cancel has fired, no later probe may spawn git — and a provider that only rejects
    // on `abort` never settles a command handed an already-aborted signal.
    if (signal?.aborted) {
      return null
    }
    try {
      const result = await runGitProbeOnHost(args, repoPath, hostId, { signal })
      return result?.stdout ?? null
    } catch {
      return null
    }
  }
}

/** Only an empty first line means the folder is the checkout's own top level: a subfolder prints
 *  `../`, and a bare repo prints nothing so whatever follows lands on the first line instead. */
function isCheckoutTopLevel(cdupStdout: string | null): boolean {
  return cdupStdout !== null && cdupStdout.split(/\r?\n/)[0] === ''
}

/** True when git shows `repoPath` is a checkout's own top level whose HEAD git finished writing. */
async function isFinishedCheckout(probe: GitProbe): Promise<boolean> {
  // Why: a clone killed before it wrote refs leaves `HEAD -> refs/heads/.invalid`, which --verify
  // rejects. One command covers a branch and a detached HEAD alike.
  const settled = await probe(['rev-parse', '--show-cdup', '--verify', 'HEAD'])
  if (settled !== null) {
    return isCheckoutTopLevel(settled)
  }
  // Why: cloning an empty repository also leaves HEAD unborn, which --verify rejects, so ask the
  // two questions apart. symbolic-ref resolves an unborn branch but not a killed clone's HEAD.
  if (!isCheckoutTopLevel(await probe(['rev-parse', '--show-cdup']))) {
    return false
  }
  return (await probe(['symbolic-ref', 'HEAD'])) !== null
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
  if (!(await isFinishedCheckout(probe))) {
    return false
  }
  const originUrl = (await probe(['config', '--get-all', 'remote.origin.url']))?.trim() ?? ''
  // Why: an origin with several URLs (fetch uses the first) prints one per line; never a match.
  if (!originUrl || originUrl.includes('\n')) {
    return false
  }
  // Why: `.git`, scheme and user spell one repo several ways; local paths don't normalize.
  const requestedKey = normalizeGitRemoteUrl(url)
  return requestedKey ? normalizeGitRemoteUrl(originUrl) === requestedKey : originUrl === url
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
        ? `Orca has that project recorded as ${storedOrigin.remoteUrl}`
        : 'Orca has no record of which repository that project holds, so it cannot tell whether the folder is missing or holds something else'
    }. Remove the project from Orca or choose another folder.`
  )
}
