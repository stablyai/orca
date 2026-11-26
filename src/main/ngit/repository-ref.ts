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
 * The forge of one branch. Git config decides first: where the branch pushes or, for a branch with no
 * upstream yet, where the default branch does. Without that, `origin`, or any remote when there is no
 * `origin`, so a second nostr mirror never takes over a GitHub branch.
 */
export async function getPrimaryNostrRepoRef(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  branch?: string
): Promise<NostrRepoRef | null> {
  const remotes = await listCachedRemoteNames(repoPath, connectionId, localGitOptions)
  const hasOrigin = !remotes || remotes.includes('origin')
  const configured =
    remotes && remotes.length > 1 ? await readBranchRemote(repoPath, branch, localGitOptions) : null
  const candidates = configured ? [configured] : hasOrigin ? ['origin'] : remotes
  return firstNostrRemote(repoPath, candidates, connectionId, localGitOptions)
}

async function readBranchRemote(
  repoPath: string,
  branch: string | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['config', '--get-regexp', '^(remote\\.pushdefault|branch\\..*\\.(remote|pushremote))$'],
      { cwd: repoPath, ...localGitOptions }
    )
    return pickBranchRemote(stdout, branch)
  } catch {
    // Git exits 1 when nothing matches.
    return null
  }
}

/** Git's own push precedence over `git config --get-regexp` output. */
export function pickBranchRemote(configLines: string, branch: string | undefined): string | null {
  const values = new Map(
    configLines.split(/\r?\n/).flatMap((line) => {
      const space = line.indexOf(' ')
      return space > 0 ? [[line.slice(0, space), line.slice(space + 1).trim()] as const] : []
    })
  )
  const name = branch?.replace(/^refs\/heads\//, '')
  const of = (target: string): string | undefined =>
    values.get(`branch.${target}.pushremote`) ??
    values.get('remote.pushdefault') ??
    values.get(`branch.${target}.remote`)
  const picked = (name ? of(name) : values.get('remote.pushdefault')) ?? of('main') ?? of('master')
  // `.` marks a branch tracking another local branch, which names no forge.
  return picked && picked !== '.' ? picked : null
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

/** The remote a merge may push to: a nostr one, never a `maintainers.yaml` guess. */
export async function getNostrPushRemote(
  repoPath: string,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string | null> {
  const remotes = (await listCachedRemoteNames(repoPath, null, localGitOptions)) ?? []
  const ordered = ['origin', ...remotes.filter((name) => name !== 'origin')]
  const ref = await firstNostrRemote(repoPath, ordered, null, localGitOptions)
  // A GRASP git URL reads fine, but only a nostr:// push publishes the merge status.
  return ref?.remoteName ?? null
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
