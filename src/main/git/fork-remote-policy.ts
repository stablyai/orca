import { acquireGitNativeFacts } from '../../shared/git-worktree-admin'
import type { GitPushTarget } from '../../shared/worktree/types'
import {
  parseGitConfigListSnapshot,
  gitConfigBoolean
} from '../../shared/git-config-snapshot-runner'
import { parseGitHubRemoteIdentity } from '../github/github-remote-identity-parsing'
import {
  resolveFetchTrackingRef,
  createFetchEffectProof
} from '../../shared/git-branch-cleanup-fetch'
import { runWithGitOperationLock } from '../../shared/git-operation-lock'
import { readGitCommonDir } from './canonical-repo-key'

export type GitExecFn = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>
export const buildNarrowForkFetchRefspec = (remote: string, branch: string): string =>
  `+refs/heads/${branch}*:refs/remotes/${remote}/${branch}*`
export const wildcardForkFetchRefspec = (remote: string): string =>
  `+refs/heads/*:refs/remotes/${remote}/*`
export function sameForkRepository(left: string, right: string): boolean {
  const key = forkRepositoryKey(left)
  return (
    left === right || Boolean(key?.startsWith('github.com/') && key === forkRepositoryKey(right))
  )
}
export function forkRepositoryKey(url: string): string | null {
  const identity = parseGitHubRemoteIdentity(url)
  if (!identity) {
    return null
  }
  const key = `${identity.host}/${identity.owner}/${identity.repo}`
  return identity.host === 'github.com' ? key.toLowerCase() : key
}
export async function withForkRemoteLock<T>(
  exec: GitExecFn,
  path: string,
  run: () => Promise<T>,
  scope = ''
): Promise<T> {
  const { stdout } = await exec(['rev-parse', '--path-format=absolute', '--git-common-dir'], path)
  const common = readGitCommonDir(stdout, path)
  if (!common) {
    throw new Error('Could not resolve repository for fork remote operation.')
  }
  return runWithGitOperationLock(`fork:${scope}:${common}`, undefined, run)
}
export async function remoteHasOrcaProvenance(
  exec: GitExecFn,
  path: string,
  remote: string
): Promise<boolean> {
  try {
    return gitConfigBoolean(
      (
        await exec(['config', '--local', '--bool', '--get', `remote.${remote}.orca-created`], path)
      ).stdout.trim()
    )
  } catch {
    return false
  }
}
export async function getRemoteFetchRefspecs(
  exec: GitExecFn,
  path: string,
  remote: string
): Promise<string[]> {
  const config = parseGitConfigListSnapshot((await exec(['config', '--list', '-z'], path)).stdout)
  return config.get(`remote.${remote}.fetch`) ?? []
}

export async function acquireForkView(exec: GitExecFn, path: string, scope = '', literal?: string) {
  const facts = await acquireGitNativeFacts(exec, path, scope, literal)
  return { ...facts, proof: createFetchEffectProof(facts.mappings, facts.refs, sameForkRepository) }
}
export const currentBranch = (view: Awaited<ReturnType<typeof acquireForkView>>) =>
  /^ref: refs\/heads\/([^\r\n]+)/.exec(view.head)?.[1]
export function isAddCollision(error: unknown, name: string): boolean {
  const stderr =
    error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr
      : ''
  const warning = (kind: string) =>
    `warning: reading remote from "${kind}/${name}", which is nominated for removal.\n\nIf you still use the "remotes/" directory it is recommended to\nmigrate to config-based remotes:\n\n\tgit remote rename ${name} ${name}\n\nIf you cannot, please let us know why you still need to use it by\nsending an e-mail to <git@vger.kernel.org>.\n`
  let diagnostic = stderr.replaceAll('\r\n', '\n')
  for (const kind of ['remotes', 'branches']) {
    diagnostic = diagnostic.replace(warning(kind), '')
  }
  diagnostic = diagnostic.trim()
  return (
    diagnostic === `fatal: remote ${name} already exists.` ||
    diagnostic === `error: remote ${name} already exists.`
  )
}
export type ForkView = Awaited<ReturnType<typeof acquireForkView>>
export function forkDestination(view: ForkView, target: GitPushTarget): string {
  const source = `refs/heads/${target.branchName}`
  const specs = view.policy.get(target.remoteName)?.get('fetch') ?? []
  const url = view.urls.get(target.remoteName)
  const endpoints = view.pushes.get(target.remoteName) ?? []
  const destination = resolveFetchTrackingRef(specs, source)
  if (
    !url ||
    (target.remoteUrl &&
      (!sameForkRepository(url, view.intended?.url ?? target.remoteUrl) ||
        !endpoints.length ||
        endpoints.some(
          (endpoint) =>
            !(view.intended?.pushes ?? [target.remoteUrl!]).some((value) =>
              sameForkRepository(endpoint, value)
            )
        ))) ||
    view.booleans.get(`remote.${target.remoteName}.mirror`) ||
    !destination ||
    !view.proof.operation(url, specs, source, 'fetch') ||
    !view.proof.unambiguous(target.remoteName, source, destination)
  ) {
    throw new Error(`No safe tracking mapping for ${target.remoteName}/${target.branchName}.`)
  }
  return destination
}
export type ForkBranchOperation = {
  target: GitPushTarget
  source: string
  destination?: string
  view?: ForkView
  localBranch?: string
  branch?: string
  scope: string
  added: boolean
  present?: boolean
}
