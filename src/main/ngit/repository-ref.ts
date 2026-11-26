import { listCachedRemoteNames } from '../git/remotes/remote-name-listing'
import { createRemoteRefProbeCache } from '../git/remotes/remote-ref-probe-cache'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import {
  parseMaintainersYaml,
  parseNostrRemoteUrl,
  type NostrRepositoryAddress
} from './nostr-repository-address'

type LocalGitExecOptions = { wslDistro?: string }

const repoRefProbeCache = createRemoteRefProbeCache(parseNostrRemoteUrl)

/** @internal - exposed for tests only */
export function _resetNostrRepoRefCache(): void {
  repoRefProbeCache.clear()
}

export type NostrRepoRef = NostrRepositoryAddress & { remoteName: string }

/**
 * The repository's own forge: `origin`, or any remote when there is no `origin`. A second nostr
 * mirror beside a GitHub origin must not take over that branch's pull request status.
 */
export async function getPrimaryNostrRepoRef(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<NostrRepoRef | null> {
  const remotes = await listCachedRemoteNames(repoPath, connectionId, localGitOptions)
  const candidates = remotes && !remotes.includes('origin') ? remotes : ['origin']
  return firstNostrRemote(repoPath, candidates, connectionId, localGitOptions)
}

/** Any nostr remote, else the checkout's `maintainers.yaml`; what the Tasks page reads. */
export async function getNostrRepoRef(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<NostrRepoRef | null> {
  const remotes = (await listCachedRemoteNames(repoPath, connectionId, localGitOptions)) ?? []
  const ordered = ['origin', ...remotes.filter((name) => name !== 'origin')]
  return (
    (await firstNostrRemote(repoPath, ordered, connectionId, localGitOptions)) ??
    readMaintainersYamlRef(repoPath, connectionId, localGitOptions)
  )
}

async function firstNostrRemote(
  repoPath: string,
  remoteNames: readonly string[],
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<NostrRepoRef | null> {
  for (const remoteName of remoteNames) {
    const address = await repoRefProbeCache.get(repoPath, remoteName, connectionId, localGitOptions)
    if (address) {
      return { ...address, remoteName }
    }
  }
  return null
}

async function readMaintainersYamlRef(
  repoPath: string,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<NostrRepoRef | null> {
  if (connectionId) {
    return null
  }
  try {
    const { stdout } = await gitExecFileAsync(['show', 'HEAD:maintainers.yaml'], {
      cwd: repoPath,
      ...localGitOptions
    })
    const folderName = repoPath.split(/[\\/]/).findLast(Boolean) ?? ''
    const address = parseMaintainersYaml(stdout, folderName)
    return address ? { ...address, remoteName: 'origin' } : null
  } catch {
    return null
  }
}
